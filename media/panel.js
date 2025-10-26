(function () {
  const vscode = acquireVsCodeApi();

  const selectors = {
    offlineBanner: document.querySelector(
      "[data-element='offline-banner']",
    ),
    repoOverlay: document.querySelector(
      "[data-element='repo-overlay']",
    ),
    root: document.querySelector(".cs-root"),
    manualNote: document.querySelector(
      "[data-role='manual-note']",
    ),
    manualCounter: document.querySelector(
      "[data-role='manual-counter']",
    ),
    noteOptOut: document.querySelector(
      "[data-role='note-opt-out']",
    ),
    commitMessage: document.querySelector(
      "[data-role='commit-message']",
    ),
    commitCounter: document.querySelector(
      "[data-role='commit-counter']",
    ),
    pushAfter: document.querySelector("[data-role='push-after']"),
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
  };

  const controlsRequiringRepo = document.querySelectorAll(
    "[data-requires-repo]",
  );
  const statusChips = new Map();
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

  const logContainers = new Map();
  const logContents = new Map();
  const LOG_PLACEHOLDER = "Logs will appear here once this step runs.";
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
      logContents.set(stepId, "");
    });

  const rerunLastButtons = new Map();
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
  updateRerunButtons();

  document
    .querySelectorAll("[data-action='toggle-section']")
    .forEach((button) => {
      button.addEventListener("click", () => {
        const sectionId = button.getAttribute("data-section-id");
        if (!sectionId) {
          return;
        }
        const collapsed =
          state.collapsedSections[sectionId] === true;
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
      updateManualCounter(selectors.manualNote.value.length);
      vscode.postMessage({
        type: "UPDATE_DRAFT_NOTE",
        payload: { value: selectors.manualNote.value },
      });
    });
  }

  document.querySelectorAll("[data-role='run-step']").forEach((button) => {
    button.addEventListener("click", () => {
      const stepId = button.getAttribute("data-step-id");
      if (!stepId) {
        return;
      }
      vscode.postMessage({
        type: "RUN_STEP",
        payload: { step: stepId },
      });
    });
  });

  const addNoteButton = document.querySelector("[data-role='add-note']");
  if (addNoteButton && selectors.manualNote) {
    addNoteButton.addEventListener("click", () => {
      vscode.postMessage({
        type: "ADD_MANUAL_NOTE",
        payload: { text: selectors.manualNote.value },
      });
    });
  }

  const loadMoreButton = document.querySelector(
    "[data-role='journal-load-more']",
  );
  if (loadMoreButton) {
    loadMoreButton.addEventListener("click", () => {
      vscode.postMessage({
        type: "REQUEST_JOURNAL_PAGE",
        payload: {},
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
  if (commitButton && selectors.commitMessage && selectors.pushAfter) {
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
    applyOffline(state.offline);
    applyRepositoryAvailability(state.repositoryAvailable);
    applyCollapsedSections(state.collapsedSections || {});
    applyDrafts();
    applySkips(state.skippable || {});
    Object.values(state.stepStatus).forEach((status) =>
      applyStepStatus(status, false),
    );
    updateRerunButtons();
  }

  function applyOffline(isOffline) {
    if (selectors.offlineBanner) {
      selectors.offlineBanner.hidden = !isOffline;
    }
  }

  function applyRepositoryAvailability(available) {
    controlsRequiringRepo.forEach((element) => {
      if (
        element instanceof HTMLButtonElement ||
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement
      ) {
        element.disabled = !available;
        element.setAttribute("aria-disabled", (!available).toString());
        if (!available) {
          element.setAttribute(
            "title",
            "Select a repository to run CommitSmith",
          );
        } else {
          element.removeAttribute("title");
          element.removeAttribute("aria-disabled");
        }
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

  function setSectionCollapsed(
    sectionId,
    collapsed,
    notifyHost,
  ) {
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
    if (toggle) {
      toggle.setAttribute("aria-expanded", (!collapsed).toString());
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

  function updateManualCounter(length) {
    if (selectors.manualCounter) {
      selectors.manualCounter.textContent = `${length} / 500`;
    }
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
        ? message.split(/\r?\n/, 1)[0] ?? ""
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

  function updateRerunButtons() {
    rerunLastButtons.forEach((button, stepId) => {
      const hasStatus =
        !!state.stepStatus && !!state.stepStatus[stepId];
      button.disabled = !hasStatus;
      if (!hasStatus) {
        button.setAttribute(
          "title",
          "Run this step once to enable rerun",
        );
        button.setAttribute("aria-disabled", "true");
      } else {
        button.removeAttribute("aria-disabled");
        button.setAttribute("title", "Rerun last command");
      }
    });
  }

  function applyLog(event) {
    if (!event || typeof event !== "object") {
      return;
    }
    const container = logContainers.get(event.step);
    if (!container) {
      return;
    }
    if (event.reset) {
      logContents.set(event.step, "");
      container.textContent = LOG_PLACEHOLDER;
      container.dataset.empty = "true";
      container.removeAttribute("data-truncated");
      return;
    }
    const current = logContents.get(event.step) ?? "";
    const next = current + (event.chunk || "");
    logContents.set(event.step, next);
    if (next.trim().length === 0) {
      container.textContent = LOG_PLACEHOLDER;
      container.dataset.empty = "true";
    } else {
      container.textContent = next;
      container.dataset.empty = "false";
    }
    if (event.truncated) {
      container.dataset.truncated = "true";
    } else {
      container.removeAttribute("data-truncated");
    }
  }

  function applyStepStatus(event, store = true) {
    if (!event || typeof event !== "object") {
      return;
    }
    if (store) {
      state.stepStatus[event.step] = event;
      updateRerunButtons();
    }
    const chip = statusChips.get(event.step);
    if (!chip) {
      return;
    }
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
    if (!store) {
      updateRerunButtons();
    }
  }
})();
