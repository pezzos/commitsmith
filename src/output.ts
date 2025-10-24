import * as vscode from "vscode";

import { getConfig, onDidChangeConfig } from "./config";

export const OUTPUT_CHANNEL_NAME = "CommitSmith";
const OUTPUT_CHANNEL_ID = "commitSmith";

export type OutputChannelLike = Pick<
  vscode.OutputChannel,
  "appendLine"
> &
  Partial<Pick<vscode.OutputChannel, "dispose" | "show">>;

let sharedChannel: OutputChannelLike | undefined;

let debugPreferenceInitialized = false;
let debugPreference = false;

function ensureDebugPreferenceLoaded(): void {
  if (debugPreferenceInitialized) {
    return;
  }
  debugPreference = getConfig().outputShowDebug;
  onDidChangeConfig((config) => {
    debugPreference = config.outputShowDebug;
  });
  debugPreferenceInitialized = true;
}

export function getOutputChannel(): OutputChannelLike {
  if (!sharedChannel) {
    sharedChannel =
      createVscodeOutputChannel() ??
      ({
        appendLine: (value: string) => {
          console.error(value);
        },
      } satisfies OutputChannelLike);
  }
  return sharedChannel;
}

export function shouldShowDebugOutput(): boolean {
  ensureDebugPreferenceLoaded();
  return debugPreference;
}

export function appendDebugLine(value: string): boolean {
  if (!shouldShowDebugOutput()) {
    return false;
  }
  getOutputChannel().appendLine(value);
  return true;
}

export function isVscodeOutputChannel(
  channel: OutputChannelLike,
): channel is vscode.OutputChannel {
  return (
    typeof (channel as vscode.OutputChannel).dispose === "function"
  );
}

function createVscodeOutputChannel():
  | vscode.OutputChannel
  | undefined {
  const createOutputChannel = vscode.window?.createOutputChannel;
  if (!createOutputChannel) {
    return undefined;
  }

  try {
    const createWithId = createOutputChannel as unknown as (options: {
      id: string;
      label: string;
      log?: boolean;
    }) => vscode.OutputChannel;
    const candidate = createWithId({
      id: OUTPUT_CHANNEL_ID,
      label: OUTPUT_CHANNEL_NAME,
    });
    if (candidate.name === OUTPUT_CHANNEL_NAME) {
      return candidate;
    }
    candidate.dispose();
  } catch {
    // Unsupported signature; fall back to classic channel creation below.
  }

  return createOutputChannel(OUTPUT_CHANNEL_NAME);
}
