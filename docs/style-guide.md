# CommitSmith UI Design & Style Charter

This charter defines a visual system that keeps the CommitSmith webview indistinguishable from VS Code’s native interface. Treat every future UI change as an implementation of these rules unless an explicit product decision mandates a deviation.

---

## Core Design Principles

- **Density First:** Match the Source Control (“CHANGES”) panel. Group headers rely on the tree’s native metrics (22 px line height, 16 px twistie column) and must not add extra padding or margins. Keep body content on the same 4–8 px rhythm to preserve the SCM cadence.
- **Theme Fidelity:** Never hardcode colors. Every background, border, or text color must come from a `--vscode-*` token so light/dark/high-contrast themes stay accurate. Prefer contextual tokens (e.g. `--vscode-sideBarBackground`) over generic colors. Honor the runtime classes that VS Code adds to the `body` (`vscode-light`, `vscode-dark`, `vscode-high-contrast`) for any theme-specific overrides.
- **Contrast Without Noise:** Rely on subtle 1 px separators (`--vscode-panel-border`) instead of thick outlines or drop shadows. Use background contrast between section header and body to create hierarchy.
- **Typography Consistency:** Use VS Code’s font stack via `font-family: var(--vscode-font-family);`. Titles are 13 px (500 weight), secondary text 11–12 px (400), log/body text 12 px. Respect tabular number features only where counts need alignment.
- **Hover & Focus Behavior:** Let the list widget supply focus visuals via `--vscode-list-*SelectionBackground` fills instead of custom outlines. Hover states use `--vscode-list-hoverBackground`; do not add glows or extra focus borders.
- **Motion as Feedback:** Keep transitions minimal (≤150 ms). Use subtle transforms for chevrons, opacity shifts for collapsible containers, and avoid disruptive animations.
- **Accessibility Baseline:** Maintain `aria-expanded`, `aria-controls`, `role`, and `hidden` attributes for accordions. Respect runtime hints like `vscode-using-screen-reader` and `vscode-reduce-motion` classes to adjust content for assistive tech and reduced-motion preferences. Always ensure text contrast meets WCAG AA by relying on VS Code tokens.

---

## Theming & Runtime Hooks

- **Theme Classes:** VS Code automatically applies `vscode-light`, `vscode-dark`, or `vscode-high-contrast` classes to the webview `body`. Use them for coarse adjustments while keeping the default experience neutral.
- **Theme Variables:** Access editor colors with CSS variables formed as `--vscode-${token}` (example: `var(--vscode-editor-foreground)`). Reference the Theme Color documentation for available tokens.
- **Font Variables:** When matching the editor, pull `--vscode-editor-font-family`, `--vscode-editor-font-weight`, and `--vscode-editor-font-size` as needed (with fallbacks).
- **Theme ID:** The body element exposes `data-vscode-theme-id` for any rare theme-specific patches. Avoid unless there’s no token equivalent.
- **Accessibility Flags:** VS Code adds `vscode-using-screen-reader` and `vscode-reduce-motion` classes when those preferences are active. Adjust layout, verbosity, and animation speed accordingly (for example, disable marquee animations when reduce-motion is present).
- **Toolkit Alignment:** The Webview UI Toolkit offers web components that already follow these rules. Although the toolkit is slated for deprecation (Jan 1, 2025), its implementation patterns remain useful references. When reusing components, plan a migration path or replicate their behavior inside CommitSmith. The toolkit already handles focus rings, hover states, and reduced-motion flags—avoid overriding them unless a parity requirement demands it.

---

## Component Style Guide

### Buttons (Webview UI Toolkit)
- Use `<vscode-button>` for every action. The toolkit exposes three key appearances: default/primary (`appearance="primary"`), secondary (`appearance="secondary"`), and icon (`appearance="icon"`).
- Padding, border radius, and typography come from the design tokens defined in `button.styles.ts` (e.g., `buttonPaddingVertical`, `cornerRadiusRound`, `typeRampBaseFontSize`). Avoid overriding these values—toolkit buttons already match the editor’s command buttons.
- Hover states update the host background (`buttonPrimaryHoverBackground`, `buttonSecondaryHoverBackground`); focus relies on `--vscode-focusBorder`. Disabled buttons reduce to `disabledOpacity` and reuse the same background tokens. The SCM tree clears list outlines, so button focus rings appear only inside the button surface—leave them intact for accessibility.
- Icon buttons remove borders and rely on the toolkit’s dotted outline; prefer them only for glyph-only affordances.

### Text Inputs & Text Areas (Webview UI Toolkit)
- Use `<vscode-text-field>` and `<vscode-text-area>` so padding, borders, and scrollbar colors stay in sync with the editor (`text-area.styles.ts` references `inputBackground`, `dropdownBorder`, `focusBorder`, etc.).
- The toolkit already sets `font-family`, `font-size`, and line height to the VS Code base ramp. Do not add surrounding labels—use the built-in `label` slot for accessible captions.
- Focus is expressed by swapping the border to `focusBorder`; disabled and read-only states reuse the same tokens with `disabledCursor` and `disabledOpacity`.
- Multi-line resizing is controlled through the `resize` attribute (`vertical`, `horizontal`, `both`, or omit for locked height).

### Checkboxes & Toggles (Webview UI Toolkit)
- Use `<vscode-checkbox>` for binary toggles. The control box is `calc(designUnit * 4px + 2px)` (~18 px) with rounded corners from `checkboxCornerRadius`.
- Labels are spaced using toolkit padding so they line up with native SCM checkboxes; additional margins are unnecessary.
- Focus sets the border to `focusBorder`, and the checked glyph fills with `foreground`. Disabled states rely on `disabledOpacity`.

### SCM Group Alignment Model
The SCM view renders group headers with the workbench tree. CommitSmith must mirror that structure so our sections (“Checks”, “Journal”, etc.) become indistinguishable from Git’s “Staged Changes”/“Changes”.

#### Structure
- Each header row is a `.monaco-list-row` generated by `WorkbenchObjectTree`. The row contains `.monaco-tl-indent`, `.monaco-tl-twistie`, and `.monaco-tl-contents`.
- `ResourceGroupRenderer.renderTemplate` (`scmViewPane.ts`, lines 448–464) appends a `.resource-group` element inside `.monaco-tl-contents` with three children: `.name`, `.actions`, and `.count`.
- The renderer forces the twistie to appear by adding `.force-twistie` to the sibling `.monaco-tl-twistie`.
- Actions are rendered with `WorkbenchToolBar` in `.actions`; the right-hand count uses `CountBadge` in `.count`. Both elements are part of the template returned from `renderTemplate`.

#### Spacing & Typography
- `.monaco-list-row` in the SCM view uses `line-height: 22px` (`scm.css`, line 118) and the default workbench font (13 px). No extra padding is applied to `.resource-group`; the row height is governed entirely by the list widget.
- `.monaco-tl-twistie` has a fixed width of 16 px, `padding-right: 6px`, and `transform: translateX(3px)` (`tree.css`, line 45). These values align the title text with the resource items directly underneath.
- `.monaco-tl-contents > div` adds `padding-right: 12px` (`scm.css`, lines 21–26) so action toolbars have room to breathe, and `.count` keeps `margin-left: 6px` when it renders (`scm.css`, lines 28–33). `.resource-group` itself is a flex row (`scm.css`, line 141); `.name` flexes to fill while actions/count hug the right edge (`scm.css`, line 246).

#### Hover, Focus, Selection & Actions
- Hover/selection fills come from the list widget (`--vscode-list-hoverBackground`, `--vscode-list-selectionBackground`, `--vscode-list-inactiveSelectionBackground`). The list intentionally clears `outline` (`list.css`, lines 30–34); rely on those fills rather than adding a focus ring.
- `.resource-group > .actions` defaults to `display: none` and is revealed on hover or focus (`scm.css`, lines 288–306). CommitSmith should follow the same rule so buttons appear only on interaction or when `show-actions` is active.
- Count badges always display the numeric value the tree provides—`CountBadge` simply formats `{0}` (`countBadge.ts`, lines 25–74). The SCM view only hides the count bubble on the provider header (`.scm-provider > .count`) when `hide-provider-counts` or `auto-provider-counts` is active (`scm.css`, lines 35–45); resource groups retain `(0)` in the UI.

#### Expand / Collapse Mechanics
- `WorkbenchObjectTree` manages expand/collapse: it updates `aria-expanded`, `aria-level`, `aria-setsize`, and `aria-posinset` on every `.monaco-list-row` (`abstractTree.ts`, lines 1808–1846) and toggles `.collapsed` on `.monaco-tl-twistie`. The chevron rotation is handled entirely through CSS (`tree.css`, line 66).
- Avoid hand-rolling chevron animations or ARIA attributes. Trigger expand/collapse through the tree API so keyboard navigation, accessibility, and context menus keep working. The tree also sets a dynamic `aria-label` per row via the accessibility provider; CommitSmith content must feed meaningful labels into that pipeline.

#### Indentation & Twistie Behavior
- `.monaco-tl-indent` starts at 16 px (`tree.css`, line 16) and renders indent guides as needed. CommitSmith must not add additional left padding; the SCM tree host already aligns the group headers with “Staged Changes”.
- The `force-twistie` class is required to display a chevron even when the resource group currently has zero children. Keep that class when we construct CommitSmith sections so the alignment matches Git.
- If the CommitSmith container adjusts margins to cancel out previous spacing bugs, leave an inline comment that documents the host-provided inset.

#### Example DOM Snapshot
```html
<div class="monaco-list-row" role="treeitem" aria-expanded="true">
  <div class="monaco-tl-indent"><!-- indent guides --></div>
  <div class="monaco-tl-twistie force-twistie"></div>
  <div class="monaco-tl-contents">
    <div class="resource-group">
      <div class="name">Staged Changes</div>
      <div class="actions"><!-- WorkbenchToolBar renders here --></div>
      <div class="count" data-count="3"></div>
    </div>
  </div>
</div>
```
This is the structure generated in `ResourceGroupRenderer.renderTemplate` and styled by `scm.css`.

### Section Separators & Spacing
- Maintain the tree’s natural rhythm. Do not introduce extra dividers between resource groups; SCM relies on list background changes rather than borders.
- When interior separation is necessary (e.g., inside a resource’s body), use `border-top: 1px solid var(--vscode-panel-border)` with 6 px padding above and below so it aligns with the SCM history list.

### Typography Hierarchy

| Role              | Font Size | Weight | Color Token                           | Notes                         |
|-------------------|-----------|--------|---------------------------------------|-------------------------------|
| Section title     | 13 px     | 500    | `--vscode-foreground`                 | Upper/lower case per copy     |
| Section subtitle  | 11 px     | 400    | `--vscode-descriptionForeground`      | Display as block under title  |
| Body text         | 12 px     | 400    | `--vscode-foreground`                 | Use standard line height 1.4  |
| Hint / status     | 11 px     | 400    | `--vscode-descriptionForeground`      | E.g., counters, timestamps    |
| Error message     | 11 px     | 400    | `--vscode-editorError-foreground`     | Reserve for critical states   |
| Success badge     | 11 px     | 600    | `--vscode-testing-iconPassed`         | Neutral background w/ opacity |

---

## Token Reference

- **Backgrounds:** `--vscode-sideBar-background`, `--vscode-editor-background`, `--vscode-sideBarSectionHeader-background`
- **Text:** `--vscode-foreground`, `--vscode-descriptionForeground`, `--vscode-textLink-foreground`
- **Borders:** `--vscode-panel-border`, `--vscode-sideBarSectionHeader-border` (fallback to `panel-border`), `--vscode-input-border`
- **State Colors:** `--vscode-focusBorder`, `--vscode-list-hoverBackground`, `--vscode-editorWarning-foreground`, `--vscode-editorError-foreground`
- **Buttons:** `--vscode-button-background`, `--vscode-button-hoverBackground`, `--vscode-button-secondaryBackground`, `--vscode-button-secondaryForeground`
- **Status Chips:** `--vscode-testing-iconPassed`, `--vscode-testing-iconFailed`, `--vscode-editorInfo-foreground`
- **Font Tokens:** `--vscode-editor-font-family`, `--vscode-editor-font-weight`, `--vscode-editor-font-size` (apply when matching editor text). 

Always guard tokens with sensible fallbacks where VS Code may omit a value (e.g., `var(--vscode-input-border, transparent)`).

---

## Implementation Checklist

1. Verify CommitSmith sections render via the SCM tree scaffold (twistie + `.resource-group` inside `.monaco-tl-contents`) and that the header text aligns with Git’s resource groups.
2. Use Webview UI Toolkit elements (`<vscode-button>`, `<vscode-text-area>`, `<vscode-checkbox>`, etc.) without overriding their design-token-based styling.
3. Test hover, focus, and selection states across light, dark, and high-contrast themes to ensure we only rely on `--vscode-*` tokens.
4. Confirm accessibility: keyboard navigation via the tree, screen-reader announcements for expand/collapse (`aria-expanded`), and focus handling inside toolkit components.
5. Run `npm run compile` after UI changes to catch regressions early.

Adhering to this charter will keep CommitSmith visually coherent with the host editor and reduce future design debt.
