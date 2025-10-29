(() => {
  function createStyle(css) {
    const style = document.createElement("style");
    style.textContent = css;
    return style;
  }

  class VSCodeButton extends HTMLElement {
    constructor() {
      super();
      this._shadow = this.attachShadow({ mode: "open" });
      this._button = document.createElement("button");
      this._button.setAttribute("part", "control");
      const slot = document.createElement("slot");
      this._button.append(slot);
      this._shadow.append(
        createStyle(`
:host {
  display: inline-flex;
}
button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font: inherit;
  padding: 4px 12px;
  border-radius: 4px;
  border: 1px solid transparent;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease, color 120ms ease, opacity 120ms ease;
}
button[data-appearance="secondary"] {
  background: var(--vscode-button-secondaryBackground, transparent);
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  border-color: var(--vscode-button-border, var(--vscode-panel-border));
}
button[data-appearance="primary"] {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
button:disabled {
  opacity: 0.6;
  cursor: default;
}
button:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: 1px;
}
        `),
        this._button,
      );
      this._button.addEventListener("click", (event) => {
        if (this.disabled) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        this.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            composed: true,
            view: window,
          }),
        );
      });
    }

    static get observedAttributes() {
      return ["appearance", "disabled"];
    }

    connectedCallback() {
      this._updateAppearance();
      this._updateDisabled();
    }

    attributeChangedCallback(name) {
      if (name === "appearance") {
        this._updateAppearance();
      } else if (name === "disabled") {
        this._updateDisabled();
      }
    }

    _updateAppearance() {
      const appearance = this.appearance;
      this._button.dataset.appearance = appearance;
    }

    _updateDisabled() {
      const disabled = this.disabled;
      this._button.disabled = disabled;
      if (disabled) {
        this.setAttribute("aria-disabled", "true");
      } else {
        this.removeAttribute("aria-disabled");
      }
    }

    get appearance() {
      const value = this.getAttribute("appearance");
      return value === "secondary" ? "secondary" : "primary";
    }

    set appearance(value) {
      if (value === "secondary") {
        this.setAttribute("appearance", "secondary");
      } else {
        this.removeAttribute("appearance");
      }
    }

    get disabled() {
      return this.hasAttribute("disabled");
    }

    set disabled(value) {
      if (value) {
        this.setAttribute("disabled", "");
      } else {
        this.removeAttribute("disabled");
      }
      this._updateDisabled();
    }

    focus(options) {
      this._button.focus(options);
    }

    click() {
      this._button.click();
    }
  }

  class VSCodeTextArea extends HTMLElement {
    constructor() {
      super();
      this._shadow = this.attachShadow({ mode: "open" });
      this._textarea = document.createElement("textarea");
      this._textarea.setAttribute("part", "control");
      this._shadow.append(
        createStyle(`
:host {
  display: block;
}
textarea {
  width: 100%;
  font: inherit;
  padding: 6px 8px;
  border-radius: 4px;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground, var(--vscode-foreground));
  resize: vertical;
  min-height: 48px;
}
textarea:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: 0;
}
textarea:disabled {
  opacity: 0.6;
}
        `),
        this._textarea,
      );
      this._textarea.addEventListener("input", () => {
        this.dispatchEvent(
          new Event("input", { bubbles: true, composed: true }),
        );
      });
      this._textarea.addEventListener("change", () => {
        this.dispatchEvent(
          new Event("change", { bubbles: true, composed: true }),
        );
      });
    }

    static get observedAttributes() {
      return ["disabled", "placeholder", "rows"];
    }

    connectedCallback() {
      this._syncAttributes();
      if (!this.hasAttribute("rows") && this._textarea.rows < 3) {
        this._textarea.rows = 3;
      }
      if (this.hasAttribute("value")) {
        this.value = this.getAttribute("value") ?? "";
      }
    }

    attributeChangedCallback(name, _oldValue, newValue) {
      if (name === "disabled") {
        this._textarea.disabled = this.disabled;
      } else if (name === "placeholder") {
        this._textarea.placeholder = newValue ?? "";
      } else if (name === "rows") {
        const rows = Number(newValue);
        if (!Number.isNaN(rows) && rows > 0) {
          this._textarea.rows = rows;
        }
      }
    }

    _syncAttributes() {
      this._textarea.disabled = this.disabled;
      this._textarea.placeholder = this.getAttribute("placeholder") ?? "";
      const rows = Number(this.getAttribute("rows"));
      if (!Number.isNaN(rows) && rows > 0) {
        this._textarea.rows = rows;
      }
    }

    get value() {
      return this._textarea.value;
    }

    set value(text) {
      this._textarea.value = text ?? "";
    }

    get disabled() {
      return this.hasAttribute("disabled");
    }

    set disabled(value) {
      if (value) {
        this.setAttribute("disabled", "");
      } else {
        this.removeAttribute("disabled");
      }
      this._textarea.disabled = this.disabled;
    }

    focus(options) {
      this._textarea.focus(options);
    }
  }

  class VSCodeCheckbox extends HTMLElement {
    constructor() {
      super();
      this._shadow = this.attachShadow({ mode: "open" });
      this._input = document.createElement("input");
      this._input.type = "checkbox";
      this._input.setAttribute("part", "control");
      this._labelSpan = document.createElement("span");
      this._labelSpan.setAttribute("part", "label");
      const slot = document.createElement("slot");
      this._labelSpan.append(slot);
      this._label = document.createElement("label");
      this._label.setAttribute("part", "container");
      this._label.append(this._input, this._labelSpan);
      this._shadow.append(
        createStyle(`
:host {
  display: inline-flex;
  align-items: center;
}
label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
input[type="checkbox"] {
  width: 16px;
  height: 16px;
  margin: 0;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: 3px;
  background: var(--vscode-input-background);
  accent-color: var(--vscode-focusBorder);
}
input[type="checkbox"]:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: 1px;
}
input[type="checkbox"]:disabled {
  opacity: 0.6;
}
        `),
        this._label,
      );
      this._input.addEventListener("change", () => {
        this.checked = this._input.checked;
        this.dispatchEvent(
          new Event("change", { bubbles: true, composed: true }),
        );
      });
    }

    static get observedAttributes() {
      return ["checked", "disabled"];
    }

    connectedCallback() {
      this._input.checked = this.checked;
      this._input.disabled = this.disabled;
    }

    attributeChangedCallback(name) {
      if (name === "checked") {
        this._input.checked = this.checked;
      } else if (name === "disabled") {
        this._input.disabled = this.disabled;
      }
    }

    get checked() {
      return this.hasAttribute("checked");
    }

    set checked(value) {
      if (value) {
        this.setAttribute("checked", "");
      } else {
        this.removeAttribute("checked");
      }
      this._input.checked = this.hasAttribute("checked");
    }

    get disabled() {
      return this.hasAttribute("disabled");
    }

    set disabled(value) {
      if (value) {
        this.setAttribute("disabled", "");
      } else {
        this.removeAttribute("disabled");
      }
      this._input.disabled = this.hasAttribute("disabled");
    }

    focus(options) {
      this._input.focus(options);
    }
  }

  class VSCodeAccordion extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" }).append(createStyle(`:host { display: block; }`), document.createElement("slot"));
      this.addEventListener(
        "vscode-accordion-item-toggle",
        (event) => {
          const item = event.detail?.item;
          if (!(item instanceof VSCodeAccordionItem)) {
            return;
          }
          if (this.mode === "single" && item.expanded) {
            this.querySelectorAll("vscode-accordion-item").forEach((other) => {
              if (other !== item) {
                other.expanded = false;
              }
            });
          }
          this.dispatchEvent(
            new CustomEvent("change", {
              detail: { item },
              bubbles: true,
              composed: true,
            }),
          );
        },
      );
    }

    get mode() {
      const attr =
        this.getAttribute("data-mode") ?? this.getAttribute("mode");
      return attr === "single" ? "single" : "multiselectable";
    }
  }

  class VSCodeAccordionItem extends HTMLElement {
    constructor() {
      super();
      this._shadow = this.attachShadow({ mode: "open" });
      this._container = document.createElement("div");
      this._container.setAttribute("part", "container");
      this._button = document.createElement("button");
      this._button.type = "button";
      this._button.setAttribute("part", "control");
      this._button.setAttribute("aria-expanded", "false");
      this._chevron = document.createElement("span");
      this._chevron.className = "chevron";
      this._chevron.setAttribute("part", "icon");
      this._title = document.createElement("span");
      this._title.setAttribute("part", "header");
      this._button.append(this._chevron, this._title);
      this._content = document.createElement("div");
      this._content.setAttribute("part", "content");
      const slot = document.createElement("slot");
      this._content.append(slot);
      this._container.append(this._button, this._content);
      this._shadow.append(
        createStyle(`
:host {
  display: block;
  border-top: 1px solid var(--vscode-panel-border);
  color: var(--vscode-foreground);
  background: transparent;
}
:host(:first-of-type) {
  border-top: none;
}
[part="content"] {
  padding: 0;
}
button {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  width: 100%;
  gap: 8px;
  padding: 4px 8px;
  font: inherit;
  color: inherit;
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
}
button:hover {
  background: var(--vscode-list-hoverBackground);
}
button:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: 1px;
}
.chevron {
  width: 6px;
  height: 6px;
  border-right: 1px solid currentColor;
  border-bottom: 1px solid currentColor;
  transform: rotate(45deg);
  transition: transform 120ms ease;
}
:host(:not([expanded])) .chevron {
  transform: rotate(-45deg);
}
[part="content"][data-hidden="true"] {
  display: none;
}
        `),
        this._container,
      );
      this._button.addEventListener("click", () => {
        const next = !this.expanded;
        this.expanded = next;
        this.dispatchEvent(
          new CustomEvent("vscode-accordion-item-toggle", {
            detail: { item: this },
            bubbles: true,
            composed: true,
          }),
        );
      });
    }

    static get observedAttributes() {
      return ["expanded", "header"];
    }

    connectedCallback() {
      this._updateHeader();
      this._applyExpanded(this.expanded);
    }

    attributeChangedCallback(name) {
      if (name === "expanded") {
        this._applyExpanded(this.expanded);
      } else if (name === "header") {
        this._updateHeader();
      }
    }

    _updateHeader() {
      const text = this.getAttribute("header") ?? "";
      this._title.textContent = text;
      this._button.setAttribute("aria-label", text);
    }

    _applyExpanded(expanded) {
      if (expanded) {
        this.setAttribute("expanded", "");
      } else {
        this.removeAttribute("expanded");
      }
      this._button.setAttribute("aria-expanded", expanded ? "true" : "false");
      this._content.dataset.hidden = expanded ? "false" : "true";
    }

    get expanded() {
      return this.hasAttribute("expanded");
    }

    set expanded(value) {
      if (value) {
        this.setAttribute("expanded", "");
      } else {
        this.removeAttribute("expanded");
      }
      this._applyExpanded(value);
    }
  }

  for (const [name, ctor] of [
    ["vscode-button", VSCodeButton],
    ["vscode-text-area", VSCodeTextArea],
    ["vscode-checkbox", VSCodeCheckbox],
    ["vscode-accordion", VSCodeAccordion],
    ["vscode-accordion-item", VSCodeAccordionItem],
  ]) {
    if (!customElements.get(name)) {
      customElements.define(name, ctor);
    }
  }
})();
