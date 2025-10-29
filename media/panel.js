(function () {
  const vscode = acquireVsCodeApi();

  const strings = {
    manualNoteEmpty: "Enter a note before adding.",
    manualNoteTooLong: "Manual notes must be 500 characters or fewer.",
    manualNoteGenericError: "Unable to add manual note.",
    journalEmpty: "Journal entries will appear here.",
    journalLoadMore: "Load more",
    manualCounter: (length, limit = 500) => `${length} / ${limit}`,
    manualCounterWarning: (length, limit = 500) =>
      `${length} / ${limit} (approaching limit)`,
  };

  const selectors = {
    offlineBanner: document.querySelector(
      "[data-element='offline-banner']",
    ),
    repoOverlay: document.querySelector(
      "[data-element='repo-overlay']",
    ),
    root: document.querySelector(".cs-root"),
    manualNote: document.querySelector("[data-role='manual-note']"),
    manualCounter: document.querySelector(
      "[data-role='manual-counter']",
    ),
    manualError: document.querySelector("[data-role='manual-error']"),
    noteOptOut: document.querySelector("[data-role='note-opt-out']"),
    commitMessage: document.querySelector(
      "[data-role='commit-message']",
    ),
    commitCounter: document.querySelector(
      "[data-role='commit-counter']",
    ),
    pushAfter: document.querySelector("[data-role='push-after']"),
    codexReview: {
      container: document.querySelector("[data-role='codex-review']"),
      text: document.querySelector("[data-role='codex-review-text']"),
      source: document.querySelector("[data-role='codex-source']"),
      confidence: document.querySelector(
        "[data-role='codex-confidence']",
      ),
      timestamp: document.querySelector(
        "[data-role='codex-timestamp']",
      ),
    },
    journalList: document.querySelector("[data-role='journal-list']"),
    journalLoadMore: document.querySelector(
      "[data-role='journal-load-more']",
    ),
  };

  const state = {
    collapsedSections: {},
    draftMessage: "",
    draftNote: "",
    manualNoteOptOut: false,
    pushAfterCommit: false,
    lastConfidence: null,
    offline: false,
    skippable: {},
    skipWarningsDismissed: false,
    repositoryAvailable: true,
    stepStatus: {},
    codexReview: null,
    journalEntries: [],
    journalHasMore: false,
    journalCursor: null,
  };

  const controlsRequiringRepo = document.querySelectorAll(
    "[data-requires-repo]",
  );
  const statusChips = new Map();
  const runButtons = new Map();
  document
    .querySelectorAll("[data-role='status-chip']")
    .forEach((chip) => {
      const stepId = chip.getAttribute("data-step-id");
      if (!stepId) {
        return;
      }
      chip.dataset.status = "idle";
      chip.textContent = "Idle";
      statusChips.set(stepId, chip);
    });

  const rerunLastButtons = new Map();
  const cancelButtons = new Map();
  const loadMoreButtons = new Map();
  let manualNotePending = false;
  let journalLoadMorePending = false;
  const runningSteps = new Set();
  const logContainers = new Map();
  const logStates = new Map();
  const LOG_PLACEHOLDER =
    "Logs will appear here once this step runs.";
  const MAX_VISIBLE_LOG_ENTRIES = 50;
  document
    .querySelectorAll("[data-role='log']")
    .forEach((element) => {
      const stepId = element.getAttribute("data-step-id");
      if (!stepId) {
        return;
      }
      element.dataset.empty = "true";
      element.textContent = LOG_PLACEHOLDER;
      logContainers.set(stepId, element);
      logStates.set(stepId, createEmptyLogState());
    });

  document
    .querySelectorAll("[data-role='rerun-last']")
    .forEach((button) => {
      const stepId = button.getAttribute("data-step-id");
      if (!stepId) {
        return;
      }
      rerunLastButtons.set(stepId, button);
      button.addEventListener("click", () => {
        vscode.postMessage({
          type: "RUN_STEP",
          payload: { step: stepId },
        });
      });
    });
  rerunLastButtons.forEach((_button, stepId) => {
    updateRerunButton(stepId);
  });

  document
    .querySelectorAll("[data-role='cancel-step']")
    .forEach((button) => {
      const stepId = button.getAttribute("data-step-id");
      if (!stepId) {
        return;
      }
      cancelButtons.set(stepId, button);
    });

  document
    .querySelectorAll("[data-role='load-more-logs']")
    .forEach((button) => {
      const stepId = button.getAttribute("data-step-id");
      if (!stepId) {
        return;
      }
      loadMoreButtons.set(stepId, button);
      button.addEventListener("click", () => {
        const stateEntry = logStates.get(stepId);
        const cursor =
          stateEntry && stateEntry.entries.length > 0
            ? stateEntry.entries[0].hash
            : undefined;
        vscode.postMessage({
          type: "REQUEST_LOG_PAGE",
          payload: { step: stepId, before: cursor },
        });
        button.disabled = true;
        button.setAttribute("aria-disabled", "true");
      });
    });
  loadMoreButtons.forEach((_button, stepId) => {
    updateLoadMoreButton(stepId);
  });

  document
    .querySelectorAll("[data-action='toggle-section']")
    .forEach((button) => {
      button.addEventListener("click", () => {
        const sectionId = button.getAttribute("data-section-id");
        if (!sectionId) {
          return;
        }
        const collapsed = state.collapsedSections[sectionId] === true;
        setSectionCollapsed(sectionId, !collapsed, true);
      });
    });

  document
    .querySelectorAll("[data-role='skip-step']")
    .forEach((checkbox) => {
      checkbox.addEventListener("change", () => {
        const stepId = checkbox.getAttribute("data-step-id");
        if (!stepId) {
          return;
        }
        vscode.postMessage({
          type: "ALLOW_SKIP",
          payload: {
            step: stepId,
            allowed: checkbox.checked,
          },
        });
      });
    });

  if (selectors.manualNote) {
    selectors.manualNote.addEventListener("input", () => {
      const value = selectors.manualNote.value ?? "";
      updateManualCounter(value.length);
      const trimmedLength = value.trim().length;
      if (trimmedLength === 0) {
        clearManualError();
      } else if (value.length > 500) {
        showManualError(strings.manualNoteTooLong);
      } else {
        clearManualError();
      }
      vscode.postMessage({
        type: "UPDATE_DRAFT_NOTE",
        payload: { value },
      });
    });
  }

  document
    .querySelectorAll("[data-role='run-step']")
    .forEach((button) => {
      const stepId = button.getAttribute("data-step-id");
      if (!stepId) {
        return;
      }
      runButtons.set(stepId, button);
      button.addEventListener("click", () => {
        vscode.postMessage({
          type: "RUN_STEP",
          payload: { step: stepId },
        });
      });
    });

  const addNoteButton = document.querySelector(
    "[data-role='add-note']",
  );
  if (addNoteButton && selectors.manualNote) {
    addNoteButton.addEventListener("click", () => {
      const rawValue = selectors.manualNote.value;
      const trimmed = typeof rawValue === "string" ? rawValue.trim() : "";
      clearManualError();
      if (trimmed.length === 0) {
        showManualError(strings.manualNoteEmpty);
        return;
      }
      if (trimmed.length > 500) {
        showManualError(strings.manualNoteTooLong);
        return;
      }
      setManualNotePending(true);
      vscode.postMessage({
        type: "ADD_MANUAL_NOTE",
        payload: { text: trimmed },
      });
    });
  }

  if (selectors.journalLoadMore) {
    selectors.journalLoadMore.textContent = strings.journalLoadMore;
    selectors.journalLoadMore.addEventListener("click", () => {
      if (!state.journalHasMore || journalLoadMorePending) {
        return;
      }
      setJournalLoadMorePending(true);
      vscode.postMessage({
        type: "REQUEST_JOURNAL_PAGE",
        payload: state.journalCursor
          ? { cursor: state.journalCursor }
          : {},
      });
    });
  }

  if (selectors.commitMessage) {
    selectors.commitMessage.addEventListener("input", () => {
      updateCommitCounter(selectors.commitMessage.value);
      vscode.postMessage({
        type: "UPDATE_DRAFT_MESSAGE",
        payload: { value: selectors.commitMessage.value },
      });
    });
  }

  const commitButton = document.querySelector("[data-role='commit']");
  if (
    commitButton &&
    selectors.commitMessage &&
    selectors.pushAfter
  ) {
    commitButton.addEventListener("click", () => {
      vscode.postMessage({
        type: "COMMIT_AND_PUSH",
        payload: {
          message: selectors.commitMessage.value,
          push: selectors.pushAfter.checked,
        },
      });
    });
  }

  if (selectors.noteOptOut) {
    selectors.noteOptOut.addEventListener("change", () => {
      vscode.postMessage({
        type: "UPDATE_NOTE_OPT_OUT",
        payload: { value: selectors.noteOptOut.checked },
      });
    });
  }

  if (selectors.pushAfter) {
    selectors.pushAfter.addEventListener("change", () => {
      vscode.postMessage({
        type: "UPDATE_PUSH_AFTER",
        payload: { value: selectors.pushAfter.checked },
      });
    });
  }

  window.addEventListener("message", (event) => {
    const { data } = event;
    if (!data || typeof data !== "object") {
      return;
    }
    switch (data.type) {
      case "STATE_SYNC":
        applyState(data.payload);
        break;
      case "STEP_STATUS":
        applyStepStatus(data.payload);
        break;
      case "APPEND_LOG":
        applyLog(data.payload);
        break;
      case "LOG_HISTORY":
        applyLogHistory(data.payload);
        break;
      case "REVIEW_RESULT":
        state.codexReview =
          data.payload && typeof data.payload === "object"
            ? data.payload
            : null;
        applyCodexReview(state.codexReview);
        break;
      case "JOURNAL_UPDATE":
        state.journalEntries = Array.isArray(data.payload)
          ? data.payload
          : [];
        renderJournal(state.journalEntries);
        journalLoadMorePending = false;
        updateJournalLoadMoreButton();
        break;
      case "MANUAL_NOTE_RESULT":
        handleManualNoteResult(data.payload);
        break;
      default:
        break;
    }
  });

  function applyState(newState) {
    if (!newState) {
      return;
    }
    state.collapsedSections = newState.collapsedSections || {};
    state.draftMessage = newState.draftMessage || "";
    state.draftNote = newState.draftNote || "";
    state.manualNoteOptOut = !!newState.manualNoteOptOut;
    state.pushAfterCommit = !!newState.pushAfterCommit;
    state.lastConfidence =
      typeof newState.lastConfidence === "number"
        ? newState.lastConfidence
        : null;
    state.offline = !!newState.offline;
    state.skippable = newState.skippable || {};
    state.skipWarningsDismissed = !!newState.skipWarningsDismissed;
    state.repositoryAvailable = !!newState.repositoryAvailable;
    state.stepStatus = newState.stepStatus || {};
    state.codexReview =
      newState.codexReview && typeof newState.codexReview === "object"
        ? newState.codexReview
        : null;
    state.journalEntries = Array.isArray(newState.journalEntries)
      ? newState.journalEntries
      : [];
    state.journalHasMore =
      typeof newState.journalHasMore === "boolean"
        ? newState.journalHasMore
        : false;
    state.journalCursor =
      typeof newState.journalCursor === "string" &&
      newState.journalCursor.length > 0
        ? newState.journalCursor
        : null;
    applyOffline(state.offline);
    applyRepositoryAvailability(state.repositoryAvailable);
    applyCollapsedSections(state.collapsedSections || {});
    applyDrafts();
    applyCodexReview(state.codexReview);
    applySkips(state.skippable || {});
    renderJournal(state.journalEntries);
    journalLoadMorePending = false;
    updateJournalLoadMoreButton();
    Object.values(state.stepStatus).forEach((status) =>
      applyStepStatus(status, false),
    );
    runButtons.forEach((_button, stepId) => {
      updateRunButtonState(stepId);
    });
    rerunLastButtons.forEach((_button, stepId) => {
      updateRerunButton(stepId);
    });
    loadMoreButtons.forEach((_button, stepId) => {
      updateLoadMoreButton(stepId);
    });
  }

  function applyOffline(isOffline) {
    if (selectors.offlineBanner) {
      selectors.offlineBanner.hidden = !isOffline;
    }
  }

  function applyRepositoryAvailability(available) {
    controlsRequiringRepo.forEach((element) => {
      if (!(element instanceof HTMLElement)) {
        return;
      }
      const role = element.getAttribute("data-role");
      const supportsDisabled =
        "disabled" in element && typeof element.disabled === "boolean";
      if (role === "rerun-failed" && supportsDisabled) {
        element.disabled = true;
        element.setAttribute("aria-disabled", "true");
        return;
      }
      if (supportsDisabled) {
        const shouldDisable = !available;
        element.disabled = shouldDisable;
        if (!available) {
          element.setAttribute("aria-disabled", "true");
          element.setAttribute(
            "title",
            "Select a repository to run CommitSmith",
          );
        } else {
          element.removeAttribute("title");
          element.removeAttribute("aria-disabled");
        }
      }
      if (role === "add-note" && manualNotePending && supportsDisabled) {
        element.disabled = true;
        element.setAttribute("aria-disabled", "true");
      }
    });
    if (selectors.root) {
      if (available) {
        delete selectors.root.dataset.disabled;
      } else {
        selectors.root.dataset.disabled = "true";
      }
    }
    if (selectors.repoOverlay) {
      selectors.repoOverlay.hidden = available;
    }
    setManualNotePending(manualNotePending);
    updateJournalLoadMoreButton();
  }

  function applyCollapsedSections(collapsed) {
    document
      .querySelectorAll("[data-section-id]")
      .forEach((section) => {
        const sectionId = section.getAttribute("data-section-id");
        if (!sectionId) {
          return;
        }
        const isCollapsed = collapsed[sectionId] === true;
        setSectionCollapsed(sectionId, isCollapsed, false);
      });
  }

  function setSectionCollapsed(sectionId, collapsed, notifyHost) {
    const section = document.querySelector(
      `[data-section-id="${sectionId}"]`,
    );
    if (!section) {
      return;
    }
    section.dataset.collapsed = collapsed ? "true" : "false";
    const toggle = section.querySelector(
      `[data-action="toggle-section"][data-section-id="${sectionId}"]`,
    );
    let content = null;
    if (toggle) {
      toggle.setAttribute("aria-expanded", (!collapsed).toString());
      const controls = toggle.getAttribute("aria-controls");
      if (controls) {
        content = document.getElementById(controls);
      }
    }
    if (!content) {
      content =
        section.querySelector(".cs-section-body") ||
        section.querySelector(".cs-step-content");
    }
    if (content instanceof HTMLElement) {
      if (collapsed) {
        content.setAttribute("hidden", "");
      } else {
        content.removeAttribute("hidden");
      }
    }
    state.collapsedSections[sectionId] = collapsed;
    if (notifyHost) {
      vscode.postMessage({
        type: "SET_SECTION_COLLAPSED",
        payload: { sectionId, collapsed },
      });
    }
  }

  function applyDrafts() {
    if (selectors.manualNote) {
      selectors.manualNote.value = state.draftNote ?? "";
      updateManualCounter(selectors.manualNote.value.length);
    }
    if (selectors.commitMessage) {
      selectors.commitMessage.value = state.draftMessage ?? "";
      updateCommitCounter(selectors.commitMessage.value);
    }
    if (selectors.noteOptOut) {
      selectors.noteOptOut.checked = !!state.manualNoteOptOut;
    }
    if (selectors.pushAfter) {
      selectors.pushAfter.checked = !!state.pushAfterCommit;
    }
  }

  function applyCodexReview(review) {
    const elements = selectors.codexReview;
    if (!elements || !elements.container || !elements.text) {
      return;
    }
    if (!review) {
      elements.container.dataset.source = "empty";
      elements.text.textContent =
        "Ask Codex Review to see insights here.";
      if (elements.source) {
        elements.source.textContent = "AI";
        elements.source.hidden = true;
      }
      if (elements.confidence) {
        elements.confidence.hidden = true;
      }
      if (elements.timestamp) {
        elements.timestamp.hidden = true;
      }
      return;
    }
    const source =
      review.source === "heuristic" ? "heuristic" : "codex";
    elements.container.dataset.source = source;
    if (elements.source) {
      elements.source.textContent =
        source === "codex" ? "AI" : "Fallback";
      elements.source.hidden = false;
    }
    if (elements.confidence) {
      const confidence = normalizeConfidence(review.confidence);
      if (confidence !== null) {
        const percent = Math.round(confidence * 100);
        elements.confidence.textContent = `Confidence ${percent}%`;
        elements.confidence.hidden = false;
      } else {
        elements.confidence.hidden = true;
      }
    }
    if (elements.timestamp) {
      const formatted = formatTimestamp(review.ts);
      if (formatted) {
        elements.timestamp.textContent = formatted;
        try {
          elements.timestamp.dateTime = new Date(
            review.ts,
          ).toISOString();
        } catch {
          elements.timestamp.removeAttribute("dateTime");
        }
        elements.timestamp.hidden = false;
      } else {
        elements.timestamp.hidden = true;
      }
    }
    const reviewText =
      typeof review.text === "string" && review.text.length > 0
        ? review.text
        : typeof review.message === "string"
          ? review.message
          : "";
    elements.text.textContent =
      reviewText.length > 0 ? reviewText : "No feedback available.";
  }

  function renderJournal(entries) {
    const list = selectors.journalList;
    if (!list) {
      return;
    }
    while (list.firstChild) {
      list.removeChild(list.firstChild);
    }
    if (!entries || entries.length === 0) {
      const empty = document.createElement("li");
      empty.className = "cs-journal-empty";
      empty.textContent = strings.journalEmpty;
      list.appendChild(empty);
      return;
    }
    const seen = new Set();
    for (const entry of entries) {
      const key =
        typeof entry?.hash === "string" && entry.hash.length > 0
          ? entry.hash
          : `${entry?.source ?? "codex"}:${entry?.ts ?? ""}:${entry?.text ?? ""}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const item = document.createElement("li");
      const sourceDetails = journalSourceDetails(entry?.source);
      item.className = "cs-journal-entry";
      item.dataset.source = sourceDetails.key;

      const meta = document.createElement("div");
      meta.className = "cs-journal-entry__meta";

      const badge = document.createElement("span");
      badge.className = "cs-badge cs-journal-badge";
      badge.textContent = sourceDetails.label;
      meta.appendChild(badge);

      const confidence = extractConfidence(entry?.metadata);
      if (confidence !== null) {
        const confidenceEl = document.createElement("span");
        confidenceEl.className = "cs-journal-confidence";
        confidenceEl.textContent = `Confidence ${Math.round(
          confidence * 100,
        )}%`;
        meta.appendChild(confidenceEl);
      }

      const timestamp = formatTimestamp(entry?.ts);
      if (timestamp) {
        const timeEl = document.createElement("time");
        timeEl.className = "cs-journal-timestamp";
        timeEl.textContent = timestamp;
        try {
          timeEl.dateTime = new Date(entry.ts).toISOString();
        } catch {
          timeEl.removeAttribute("dateTime");
        }
        meta.appendChild(timeEl);
      }

      item.appendChild(meta);

      const text = document.createElement("p");
      text.className = "cs-journal-entry__text";
      const entryText =
        typeof entry?.text === "string" && entry.text.length > 0
          ? entry.text
          : typeof entry?.message === "string"
            ? entry.message
            : "";
      text.textContent = entryText;
      item.appendChild(text);

      list.appendChild(item);
    }
  }

  function handleManualNoteResult(result) {
    setManualNotePending(false);
    if (!result || typeof result !== "object") {
      return;
    }
    if (!result.success) {
      showManualError(
        typeof result.message === "string" && result.message.length > 0
          ? result.message
          : strings.manualNoteGenericError,
      );
      return;
    }
    clearManualError();
  }

  function showManualError(message) {
    if (!selectors.manualError) {
      return;
    }
    selectors.manualError.textContent =
      typeof message === "string" && message.length > 0
        ? message
        : strings.manualNoteGenericError;
    selectors.manualError.hidden = false;
  }

  function clearManualError() {
    if (!selectors.manualError) {
      return;
    }
    selectors.manualError.textContent = "";
    selectors.manualError.hidden = true;
  }

  function setManualNotePending(pending) {
    manualNotePending = pending;
    if (
      !addNoteButton ||
      typeof addNoteButton !== "object" ||
      !("disabled" in addNoteButton)
    ) {
      return;
    }
    addNoteButton.disabled = pending || !state.repositoryAvailable;
    if (addNoteButton.disabled) {
      addNoteButton.setAttribute("aria-disabled", "true");
    } else {
      addNoteButton.removeAttribute("aria-disabled");
    }
  }

  function setJournalLoadMorePending(pending) {
    journalLoadMorePending = pending;
    updateJournalLoadMoreButton();
  }

  function updateJournalLoadMoreButton() {
    const button = selectors.journalLoadMore;
    if (
      !button ||
      typeof button !== "object" ||
      !("disabled" in button)
    ) {
      return;
    }
    const shouldDisable =
      !state.repositoryAvailable ||
      !state.journalHasMore ||
      journalLoadMorePending;
    button.disabled = shouldDisable;
    if (shouldDisable) {
      button.setAttribute("aria-disabled", "true");
    } else {
      button.removeAttribute("aria-disabled");
    }
  }

  function normalizeConfidence(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
    if (value < 0) {
      return 0;
    }
    if (value > 1) {
      return 1;
    }
    return value;
  }

  function extractConfidence(metadata) {
    if (!metadata || typeof metadata !== "object") {
      return null;
    }
    const value = metadata.confidence;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
    if (value < 0) {
      return 0;
    }
    if (value > 1) {
      return 1;
    }
    return value;
  }

  function journalSourceDetails(source) {
    switch (source) {
      case "pipeline":
        return { key: "pipeline", label: "Pipeline" };
      case "manual":
        return { key: "manual", label: "Manual" };
      default:
        return { key: "codex", label: "AI" };
    }
  }

  function formatTimestamp(value) {
    if (!value) {
      return "";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "";
    }
    return date.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function updateManualCounter(length) {
    if (!selectors.manualCounter) {
      return;
    }
    const warningThreshold = 480;
    const text =
      length >= warningThreshold
        ? strings.manualCounterWarning(length)
        : strings.manualCounter(length);
    selectors.manualCounter.textContent = text;
    selectors.manualCounter.classList.toggle(
      "cs-counter--warning",
      length >= warningThreshold,
    );
  }

  function updateCommitCounter(message) {
    if (!selectors.commitCounter) {
      return;
    }
    const headerLength = getHeaderLength(message);
    selectors.commitCounter.textContent = `${headerLength} / 72`;
  }

  function getHeaderLength(message) {
    const firstLine =
      typeof message === "string"
        ? (message.split(/\r?\n/, 1)[0] ?? "")
        : "";
    return firstLine.length;
  }

  function applySkips(skippable) {
    document
      .querySelectorAll("[data-role='skip-step']")
      .forEach((checkbox) => {
        const stepId = checkbox.getAttribute("data-step-id");
        if (!stepId) {
          return;
        }
        checkbox.checked = !!skippable[stepId];
      });
  }

  function updateRerunButton(stepId) {
    const button = rerunLastButtons.get(stepId);
    if (!button) {
      return;
    }
    const hasStatus =
      !!state.stepStatus && !!state.stepStatus[stepId];
    if (!state.repositoryAvailable) {
      button.disabled = true;
      button.setAttribute("aria-disabled", "true");
      button.setAttribute(
        "title",
        "Select a repository to run CommitSmith",
      );
      return;
    }
    if (!hasStatus) {
      button.disabled = true;
      button.setAttribute("aria-disabled", "true");
      button.setAttribute(
        "title",
        "Run this step once to enable rerun",
      );
      return;
    }
    if (runningSteps.has(stepId)) {
      button.disabled = true;
      button.setAttribute("aria-disabled", "true");
      button.setAttribute(
        "title",
        "Wait for the current run to finish",
      );
      return;
    }
    button.disabled = false;
    button.removeAttribute("aria-disabled");
    button.setAttribute("title", "Rerun last command");
  }

  function updateRunButtonState(stepId) {
    const button = runButtons.get(stepId);
    if (!button) {
      return;
    }
    const shouldDisable =
      runningSteps.has(stepId) || !state.repositoryAvailable;
    button.disabled = shouldDisable;
    if (shouldDisable) {
      button.setAttribute("aria-disabled", "true");
    } else {
      button.removeAttribute("aria-disabled");
    }
  }

  function createEmptyLogState() {
    return {
      entries: [],
      hashes: new Set(),
      truncated: false,
      hasMore: false,
      expanded: false,
    };
  }

  function resetLogState(logState) {
    logState.entries = [];
    logState.hashes.clear();
    logState.truncated = false;
    logState.hasMore = false;
    logState.expanded = false;
  }

  function getOrCreateLogState(stepId) {
    let logState = logStates.get(stepId);
    if (!logState) {
      logState = createEmptyLogState();
      logStates.set(stepId, logState);
    }
    return logState;
  }

  function updateLoadMoreButton(stepId) {
    const button = loadMoreButtons.get(stepId);
    if (!button) {
      return;
    }
    if (!state.repositoryAvailable) {
      button.disabled = true;
      button.setAttribute("aria-disabled", "true");
      return;
    }
    const logState = logStates.get(stepId);
    const enable = !!logState && logState.hasMore;
    button.disabled = !enable;
    if (enable) {
      button.removeAttribute("aria-disabled");
    } else {
      button.setAttribute("aria-disabled", "true");
    }
  }

  function applyLog(
    event,
    mode = "append",
    updateControls = true,
    renderView = true,
  ) {
    if (!event || typeof event !== "object") {
      return;
    }
    const logState = getOrCreateLogState(event.step);
    if (event.reset) {
      resetLogState(logState);
      if (renderView) {
        renderLog(event.step, false);
      }
      if (updateControls) {
        updateLoadMoreButton(event.step);
      }
      return;
    }
    if (event.hash && logState.hashes.has(event.hash)) {
      return;
    }
    if (event.hash) {
      logState.hashes.add(event.hash);
    }
    if (mode === "prepend") {
      logState.entries.unshift(event);
      logState.expanded = true;
    } else {
      logState.entries.push(event);
      if (
        !logState.expanded &&
        logState.entries.length > MAX_VISIBLE_LOG_ENTRIES
      ) {
        const removeCount =
          logState.entries.length - MAX_VISIBLE_LOG_ENTRIES;
        const removed = logState.entries.splice(0, removeCount);
        for (const entry of removed) {
          logState.hashes.delete(entry.hash);
        }
        logState.hasMore = true;
      }
    }
    if (event.truncated) {
      logState.truncated = true;
    }
    if (renderView) {
      renderLog(event.step, mode === "prepend");
    }
    if (updateControls) {
      updateLoadMoreButton(event.step);
    }
  }

  function renderLog(stepId, wasPrepend) {
    const container = logContainers.get(stepId);
    if (!container) {
      return;
    }
    const logState = getOrCreateLogState(stepId);
    const previousScrollHeight = container.scrollHeight;
    const previousScrollTop = container.scrollTop;
    const isAtBottom =
      container.scrollTop + container.clientHeight >=
      container.scrollHeight - 8;
    if (logState.entries.length === 0) {
      container.textContent = LOG_PLACEHOLDER;
      container.dataset.empty = "true";
    } else {
      container.textContent = logState.entries
        .map((entry) => entry.chunk)
        .join("");
      container.dataset.empty = "false";
    }
    if (logState.truncated) {
      container.dataset.truncated = "true";
    } else {
      container.removeAttribute("data-truncated");
    }
    if (wasPrepend) {
      const newScrollHeight = container.scrollHeight;
      container.scrollTop =
        previousScrollTop + (newScrollHeight - previousScrollHeight);
    } else if (isAtBottom) {
      container.scrollTop = container.scrollHeight;
    }
  }

  function applyLogHistory(payload) {
    if (
      !payload ||
      typeof payload !== "object" ||
      !Array.isArray(payload.entries)
    ) {
      return;
    }
    const stepId = payload.step;
    if (!stepId) {
      return;
    }
    const logState = getOrCreateLogState(stepId);
    if (payload.entries.length > 0) {
      for (
        let index = payload.entries.length - 1;
        index >= 0;
        index -= 1
      ) {
        applyLog(payload.entries[index], "prepend", false, false);
      }
      renderLog(stepId, true);
    }
    logState.hasMore = !!payload.hasMore;
    logState.expanded = true;
    updateLoadMoreButton(stepId);
  }

  function applyStepStatus(event, store = true) {
    if (!event || typeof event !== "object") {
      return;
    }
    if (store) {
      state.stepStatus[event.step] = event;
    }
    const chip = statusChips.get(event.step);
    if (chip) {
      const status = event.status;
      chip.dataset.status = status;
      let label = "Idle";
      switch (status) {
        case "running":
          label = event.message || "Running…";
          break;
        case "success":
          label = event.message || "Success";
          break;
        case "error":
          label = event.message || "Needs attention";
          break;
        default:
          chip.dataset.status = "idle";
          break;
      }
      chip.textContent = label;
      if (event.tooltip) {
        chip.title = event.tooltip;
      } else if (event.message) {
        chip.title = event.message;
      } else {
        chip.removeAttribute("title");
      }
    }
    if (event.status === "running") {
      runningSteps.add(event.step);
    } else {
      runningSteps.delete(event.step);
    }
    updateRunButtonState(event.step);
    updateRerunButton(event.step);
  }
})();
