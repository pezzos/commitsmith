import type { Memento } from "vscode";

export type PreferenceStore = Pick<Memento, "get" | "update">;

const FAST_LANE_REMINDER_KEY =
  "commitSmith.preferences.fastLaneReminderAcknowledged";

export function hasAcknowledgedFastLaneReminder(
  store: PreferenceStore,
): boolean {
  return store.get<boolean>(FAST_LANE_REMINDER_KEY, false) === true;
}

export async function recordFastLaneReminderAcknowledged(
  store: PreferenceStore,
): Promise<void> {
  await store.update(FAST_LANE_REMINDER_KEY, true);
}

export function resetFastLaneReminder(store: PreferenceStore): Thenable<void> {
  return store.update(FAST_LANE_REMINDER_KEY, undefined);
}

export { FAST_LANE_REMINDER_KEY };
