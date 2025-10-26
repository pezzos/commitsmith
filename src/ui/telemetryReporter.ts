import { recordTelemetry } from "../telemetry";

export interface TelemetryReporter {
  track(event: string, properties?: Record<string, unknown>): void;
}

export class UiTelemetryReporter implements TelemetryReporter {
  constructor(private readonly schema = "ui.panel") {}

  track(event: string, properties: Record<string, unknown> = {}): void {
    const serialized: Record<string, string> = {};
    for (const [key, value] of Object.entries(properties)) {
      serialized[key] = String(value);
    }
    recordTelemetry({
      name: event,
      schema: this.schema,
      schemaVersion: 1,
      properties: serialized,
    });
  }
}

export class NoopTelemetryReporter implements TelemetryReporter {
  track(): void {
    // Intentionally empty.
  }
}
