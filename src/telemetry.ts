import * as vscode from "vscode";

export interface TelemetryEvent {
  readonly name: string;
  readonly schema: string;
  readonly schemaVersion: number;
  readonly properties?: Record<string, string>;
  readonly measurements?: Record<string, number>;
}

const telemetryEmitter = new vscode.EventEmitter<TelemetryEvent>();

export const onTelemetryEvent = telemetryEmitter.event;

export function recordTelemetry(event: TelemetryEvent): void {
  telemetryEmitter.fire(event);
}
