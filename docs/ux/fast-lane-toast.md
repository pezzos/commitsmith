# Fast Lane Reminder Toast — UX Sign-off

- **Date:** 2024-06-18
- **Reviewers:** A. Pezzotta, UX Guild async thread
- **Artefact:** Storybook scenario `CommitSmith/Fast Lane/FastLaneReminderToast` (see Storybook build `storybook-fast-lane-toast@2024-06-18`).
- **Screenshot:** Stored in design hub as `fast-lane-reminder-toast.png` (Figma › CommitSmith › Fast Lane, frame `Toast Manual Commands`).

## Notes

- Verified button labels render as the literal manual commands:
  - `npm run format:fix`
  - `npm run typecheck`
  - `npm run test:all`
- Confirmed dismiss control copies UX copy approved in spec ("Don't remind me again").
- Manual command helper text references the terminal hand-off pattern agreed with DX team.

## Acceptance Checklist

- [x] Toast surfaces once per user and points to manual commands.
- [x] Manual command call-to-actions align with documentation.
- [x] Permanent dismissal affordance present and labelled per UX spec.
- [x] Storybook capture attached for audit trail.
