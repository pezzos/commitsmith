import * as vscode from "vscode";

import {
  addEntry,
  readJournal,
  type JournalEntry as StorageJournalEntry,
} from "../../journal";
import { appendDebugLine } from "../../output";
import type { JournalEntry } from "../../shared/types";
import { UiTelemetryReporter } from "../telemetryReporter";
import { SecretMasker } from "./security";
import { CommitSmithUIBridge } from "./bridge";
import { RepositorySelector } from "./repositorySelector";
import type { PersistedUiState } from "./stateStore";
import { CommitSmithStateStore } from "./stateStore";
import {
  JOURNAL_PAGE_SIZE,
  applyManualNotesToDraft,
  dedupeJournalEntries,
  ensureJournalEntryHash,
  JournalEntryWithHash,
} from "./journalUtils";

interface JournalControllerDeps {
  readonly stateStore: CommitSmithStateStore;
  readonly bridge: CommitSmithUIBridge;
  readonly repositorySelector: RepositorySelector;
  readonly telemetry: UiTelemetryReporter;
}

interface ManualNoteResultPayload {
  readonly success: boolean;
  readonly message?: string;
}

export class JournalController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly entries: JournalEntryWithHash[] = [];
  private displayedCount = 0;
  private readonly masker = new SecretMasker();
  private isSyncingState = false;
  private lastKnownOptOut: boolean;
  private refreshing = false;

  constructor(private readonly deps: JournalControllerDeps) {
    this.lastKnownOptOut = deps.stateStore.state.manualNoteOptOut;
    this.bootstrapFromState();
    this.disposables.push(
      deps.bridge.onDidReceiveMessage((message) => {
        void this.handleMessage(message);
      }),
      deps.stateStore.onDidChange((state) => {
        this.handleStateChange(state);
      }),
      deps.repositorySelector.onDidChange(() => {
        void this.reloadFromSource();
      }),
    );
    void this.reloadFromSource();
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    this.masker.dispose();
  }

  async addEntry(entry: JournalEntry): Promise<void> {
    await this.appendEntries([entry]);
  }

  private bootstrapFromState(): void {
    const persisted = this.deps.stateStore.state.journalEntries ?? [];
    const normalized = dedupeJournalEntries(
      persisted.map((entry) => ensureJournalEntryHash(entry)),
    );
    this.entries.splice(0, this.entries.length, ...normalized);
    this.displayedCount = Math.min(
      normalized.length,
      Math.max(persisted.length, JOURNAL_PAGE_SIZE),
    );
    void this.syncState(false);
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (
      !message ||
      typeof message !== "object" ||
      typeof (message as { type?: unknown }).type !== "string"
    ) {
      return;
    }
    const kind = (message as { type: string }).type;
    switch (kind) {
      case "ADD_MANUAL_NOTE": {
        const payload = (message as {
          payload?: { text?: string };
        }).payload;
        await this.handleManualNote(payload?.text ?? "");
        break;
      }
      case "REQUEST_JOURNAL_PAGE": {
        this.handleJournalPageRequest();
        break;
      }
      default:
        break;
    }
  }

  private async handleManualNote(rawText: string): Promise<void> {
    const normalized = normalizeManualNote(rawText);
    if (normalized.length === 0) {
      this.sendManualNoteResult({
        success: false,
        message: "Enter a note before adding.",
      });
      return;
    }
    if (normalized.length > 500) {
      this.sendManualNoteResult({
        success: false,
        message: "Manual notes must be 500 characters or fewer.",
      });
      return;
    }
    const repository = this.deps.repositorySelector.active;
    if (!repository) {
      this.sendManualNoteResult({
        success: false,
        message: "Select a repository before adding notes.",
      });
      return;
    }
    const entry: JournalEntry = {
      ts: new Date().toISOString(),
      source: "manual",
      text: normalized,
      message: `[manual-entry] ${normalized}`,
    };
    const journalRecord: StorageJournalEntry = {
      message: `[manual-entry] ${normalized}`,
      ts: entry.ts,
      source: "manual",
    };
    try {
      await addEntry(journalRecord, { root: repository.rootUri.fsPath });
      await this.appendEntries([entry]);
      await this.deps.stateStore.update("draftNote", "");
      this.sendManualNoteResult({ success: true });
      const maskedPreview = this.masker.mask(normalized).slice(0, 120);
      this.deps.telemetry.track("manual_note_added", {
        length: normalized.length,
        notes: this.entries.filter(
          (candidate) => candidate.source === "manual",
        ).length,
        preview: maskedPreview,
      });
      appendDebugLine(
        `[CommitSmith][journal] Added manual note (len=${normalized.length}).`,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      const maskedMessage = this.masker.mask(message);
      appendDebugLine(
        `[CommitSmith][journal] Failed to persist manual note: ${maskedMessage}`,
      );
      this.sendManualNoteResult({
        success: false,
        message: "Unable to write manual note to journal.",
      });
    }
  }

  private handleJournalPageRequest(): void {
    if (this.entries.length === 0) {
      void this.syncState(true);
      return;
    }
    const nextCount = Math.min(
      this.entries.length,
      this.displayedCount + JOURNAL_PAGE_SIZE,
    );
    if (nextCount === this.displayedCount) {
      void this.syncState(true);
      return;
    }
    this.displayedCount = nextCount;
    void this.syncState();
  }

  private handleStateChange(state: PersistedUiState): void {
    if (this.isSyncingState) {
      return;
    }
    if (state.manualNoteOptOut !== this.lastKnownOptOut) {
      this.lastKnownOptOut = state.manualNoteOptOut;
      void this.reconcileDraftMessage();
    }
  }

  private async appendEntries(
    entries: readonly JournalEntry[],
  ): Promise<void> {
    if (!entries || entries.length === 0) {
      return;
    }
    const normalized = entries.map((entry) =>
      ensureJournalEntryHash(entry),
    );
    const merged = dedupeJournalEntries([
      ...normalized,
      ...this.entries,
    ]);
    this.entries.splice(0, this.entries.length, ...merged);
    this.displayedCount = Math.min(
      this.entries.length,
      Math.max(
        this.displayedCount > 0
          ? this.displayedCount
          : JOURNAL_PAGE_SIZE,
        JOURNAL_PAGE_SIZE,
      ),
    );
    await this.syncState();
  }

  private async syncState(broadcast = true): Promise<void> {
    const slice = this.entries.slice(0, this.displayedCount);
    this.isSyncingState = true;
    try {
      await this.deps.stateStore.updateMany({
        journalEntries: slice,
        journalCursor:
          slice.length > 0 ? slice[slice.length - 1].hash : null,
        journalHasMore: this.displayedCount < this.entries.length,
      });
    } finally {
      this.isSyncingState = false;
    }
    if (broadcast) {
      this.deps.bridge.postMessage({
        type: "JOURNAL_UPDATE",
        payload: slice,
      });
    }
    await this.reconcileDraftMessage();
  }

  private async reloadFromSource(): Promise<void> {
    if (this.refreshing) {
      return;
    }
    this.refreshing = true;
    try {
      const repo = this.deps.repositorySelector.active;
      const manualEntries = this.entries.filter(
        (entry) => entry.source === "manual",
      );
      if (!repo) {
        this.entries.splice(0, this.entries.length, ...manualEntries);
        this.displayedCount = Math.min(
          this.entries.length,
          Math.max(this.displayedCount || JOURNAL_PAGE_SIZE, JOURNAL_PAGE_SIZE),
        );
        await this.syncState();
        return;
      }
      const journal = await readJournal({
        root: repo.rootUri.fsPath,
        createIfMissing: false,
      });
      const fileEntries = mapJournalEntries(journal.current);
      const merged = dedupeJournalEntries([
        ...manualEntries,
        ...fileEntries,
      ]);
      this.entries.splice(0, this.entries.length, ...merged);
      this.displayedCount = Math.min(
        this.entries.length,
        Math.max(this.displayedCount || JOURNAL_PAGE_SIZE, JOURNAL_PAGE_SIZE),
      );
      await this.syncState();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      appendDebugLine(
        `[CommitSmith][journal] Failed to refresh journal entries: ${message}`,
      );
    } finally {
      this.refreshing = false;
    }
  }

  private async reconcileDraftMessage(): Promise<void> {
    const state = this.deps.stateStore.state;
    const manualNotes = this.entries.filter(
      (entry) => entry.source === "manual",
    );
    const nextDraft = applyManualNotesToDraft(
      state.draftMessage ?? "",
      manualNotes,
      state.manualNoteOptOut,
    );
    if (nextDraft === state.draftMessage) {
      return;
    }
    this.isSyncingState = true;
    try {
      await this.deps.stateStore.update("draftMessage", nextDraft);
    } finally {
      this.isSyncingState = false;
    }
  }

  private sendManualNoteResult(payload: ManualNoteResultPayload): void {
    this.deps.bridge.postMessage({
      type: "MANUAL_NOTE_RESULT",
      payload,
    });
  }
}

function normalizeManualNote(value: string): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/\r?\n/g, "\n").trim();
}

function mapJournalEntries(
  entries: readonly StorageJournalEntry[],
): JournalEntryWithHash[] {
  return entries
    .map((entry, index) => mapJournalEntry(entry, index))
    .map((entry) => ensureJournalEntryHash(entry));
}

function mapJournalEntry(
  entry: StorageJournalEntry,
  index: number,
): JournalEntry {
  const rawMessage =
    typeof entry.message === "string" ? entry.message : "";
  const normalizedSource =
    entry.source === "manual" || entry.source === "pipeline"
      ? entry.source
      : "codex";
  const derivedSource =
    normalizedSource === "manual" ||
    rawMessage.toLowerCase().startsWith("[manual-entry]")
      ? "manual"
      : normalizedSource;
  const displayText = deriveDisplayText(rawMessage);
  const metadata = deriveMetadata(entry);
  const ts =
    typeof entry.ts === "string" && entry.ts.length > 0
      ? entry.ts
      : fallbackTimestamp(index);
  return {
    ts,
    source: derivedSource,
    text: displayText,
    message: rawMessage.length > 0 ? rawMessage : undefined,
    ...(metadata ? { metadata } : {}),
  };
}

function deriveDisplayText(message: string): string {
  if (message.toLowerCase().startsWith("[manual-entry]")) {
    return message.replace(/^\[manual-entry\]\s*/i, "").trim();
  }
  return message.trim();
}

function deriveMetadata(
  entry: StorageJournalEntry,
): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};
  if (entry.metadata && typeof entry.metadata === "object") {
    Object.assign(metadata, entry.metadata);
  }
  if (entry.file && typeof entry.file === "string") {
    metadata.file = entry.file;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function fallbackTimestamp(index: number): string {
  const seconds = index % 60;
  const minutes = Math.floor(index / 60) % 60;
  const hours = Math.floor(index / 3600) % 24;
  const day = 1 + Math.floor(index / 86400);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `1970-01-${pad(day)}T${pad(hours)}:${pad(minutes)}:${pad(seconds)}Z`;
}
