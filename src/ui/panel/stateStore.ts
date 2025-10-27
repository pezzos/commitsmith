import * as vscode from "vscode";
import {
  CodexReviewSnapshot,
  JournalEntry,
  StepId,
  StepStatusEvent,
} from "../../shared/types";

import { ensureJournalEntryHash } from "./journalUtils";

type CollapsedSections = Record<string, boolean>;
type SkippableMap = Partial<Record<StepId, boolean>>;

export interface PersistedUiState {
  readonly collapsedSections: CollapsedSections;
  readonly draftMessage: string;
  readonly draftNote: string;
  readonly manualNoteOptOut: boolean;
  readonly pushAfterCommit: boolean;
  readonly lastConfidence: number | null;
  readonly codexReview: CodexReviewSnapshot | null;
  readonly offline: boolean;
  readonly skippable: SkippableMap;
  readonly skipWarningsDismissed: boolean;
  readonly journalEntries: readonly JournalEntry[];
  readonly journalCursor: string | null;
  readonly journalHasMore: boolean;
  readonly stepStatus: Partial<Record<StepId, StepStatusEvent>>;
}

type UiStateKey = keyof PersistedUiState;

const STORAGE_KEY = "commitSmith.ui.state";

const DEFAULT_STATE: PersistedUiState = {
  collapsedSections: {},
  draftMessage: "",
  draftNote: "",
  manualNoteOptOut: false,
  pushAfterCommit: false,
  lastConfidence: null,
  codexReview: null,
  offline: false,
  skippable: {},
  skipWarningsDismissed: false,
  journalEntries: [],
  journalCursor: null,
  journalHasMore: false,
  stepStatus: {},
};

export class CommitSmithStateStore implements vscode.Disposable {
  private readonly emitter =
    new vscode.EventEmitter<PersistedUiState>();
  readonly onDidChange = this.emitter.event;
  private cache: PersistedUiState;

  constructor(private readonly memento: vscode.Memento) {
    this.cache = this.load();
  }

  get state(): PersistedUiState {
    return this.cache;
  }

  get<K extends UiStateKey>(key: K): PersistedUiState[K] {
    return this.cache[key];
  }

  async update<K extends UiStateKey>(
    key: K,
    value: PersistedUiState[K],
  ): Promise<void> {
    if (this.cache[key] === value) {
      return;
    }
    this.cache = {
      ...this.cache,
      [key]: value,
    } as PersistedUiState;
    await this.persist();
    this.emitter.fire(this.cache);
  }

  async updateMany(
    partial: Partial<PersistedUiState>,
  ): Promise<void> {
    this.cache = {
      ...this.cache,
      ...partial,
    };
    await this.persist();
    this.emitter.fire(this.cache);
  }

  async reset(): Promise<void> {
    this.cache = { ...DEFAULT_STATE };
    await this.persist();
    this.emitter.fire(this.cache);
  }

  dispose(): void {
    this.emitter.dispose();
  }

  private load(): PersistedUiState {
    const stored = this.memento.get<PersistedUiState>(STORAGE_KEY);
    if (!stored) {
      return { ...DEFAULT_STATE };
    }

    return {
      ...DEFAULT_STATE,
      ...stored,
      codexReview: stored.codexReview
        ? {
            source: stored.codexReview.source,
            text: stored.codexReview.text,
            confidence:
              typeof stored.codexReview.confidence === "number"
                ? stored.codexReview.confidence
                : null,
            ts: stored.codexReview.ts,
          }
        : DEFAULT_STATE.codexReview,
      collapsedSections: {
        ...DEFAULT_STATE.collapsedSections,
        ...stored.collapsedSections,
      },
      journalEntries: Array.isArray(stored.journalEntries)
        ? stored.journalEntries.map((entry) => ensureJournalEntryHash(entry))
        : DEFAULT_STATE.journalEntries.slice(),
      journalCursor:
        typeof stored.journalCursor === "string" &&
        stored.journalCursor.length > 0
          ? stored.journalCursor
          : null,
      journalHasMore:
        typeof stored.journalHasMore === "boolean"
          ? stored.journalHasMore
          : DEFAULT_STATE.journalHasMore,
      skippable: {
        ...DEFAULT_STATE.skippable,
        ...stored.skippable,
      },
      stepStatus: {
        ...DEFAULT_STATE.stepStatus,
        ...stored.stepStatus,
      },
    };
  }

  private async persist(): Promise<void> {
    await this.memento.update(STORAGE_KEY, this.cache);
  }

  async setStepStatus(
    step: StepId,
    status: StepStatusEvent,
  ): Promise<void> {
    const next = {
      ...this.cache.stepStatus,
      [step]: status,
    };
    await this.update("stepStatus", next);
  }
}
