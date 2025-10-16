import * as vscode from 'vscode';

export const OUTPUT_CHANNEL_NAME = 'CommitSmith';

export type OutputChannelLike = Pick<vscode.OutputChannel, 'appendLine'> &
  Partial<Pick<vscode.OutputChannel, 'dispose' | 'show'>>;

let sharedChannel: OutputChannelLike | undefined;

export function getOutputChannel(): OutputChannelLike {
  if (!sharedChannel) {
    sharedChannel =
      vscode.window?.createOutputChannel?.(OUTPUT_CHANNEL_NAME) ??
      ({
        appendLine: (value: string) => {
          console.error(value);
        }
      } satisfies OutputChannelLike);
  }
  return sharedChannel;
}

export function isVscodeOutputChannel(channel: OutputChannelLike): channel is vscode.OutputChannel {
  return typeof (channel as vscode.OutputChannel).dispose === 'function';
}
