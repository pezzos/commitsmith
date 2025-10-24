import type { Disposable, Event } from "vscode";

export interface TelemetryEvent {
  readonly name: string;
  readonly schema: string;
  readonly schemaVersion: number;
  readonly properties?: Record<string, string>;
  readonly measurements?: Record<string, number>;
}

type TelemetryEmitter<TEvent> = {
  event: Event<TEvent>;
  fire(data: TEvent): void;
  dispose(): void;
};

const telemetryEmitter = createTelemetryEmitter<TelemetryEvent>();

export const onTelemetryEvent = telemetryEmitter.event;

export function recordTelemetry(event: TelemetryEvent): void {
  telemetryEmitter.fire(event);
}

function createTelemetryEmitter<TEvent>(): TelemetryEmitter<TEvent> {
  const vscodeModule = tryRequireVscode();
  if (vscodeModule) {
    return new vscodeModule.EventEmitter<TEvent>();
  }

  return createFallbackEmitter<TEvent>();
}

function tryRequireVscode(): typeof import("vscode") | undefined {
  try {
    return require("vscode") as typeof import("vscode");
  } catch {
    return undefined;
  }
}

function createFallbackEmitter<TEvent>(): TelemetryEmitter<TEvent> {
  const listeners = new Set<{
    listener: (data: TEvent) => void;
    thisArgs?: unknown;
  }>();

  return {
    event: (listener, thisArgs, disposables) => {
      const entry = { listener, thisArgs };
      listeners.add(entry);

      const subscription: Disposable = {
        dispose: () => {
          listeners.delete(entry);
        },
      };

      if (Array.isArray(disposables)) {
        disposables.push(subscription);
      }

      return subscription;
    },
    fire: (data) => {
      for (const { listener, thisArgs } of listeners) {
        listener.call(thisArgs, data);
      }
    },
    dispose: () => {
      listeners.clear();
    },
  };
}
