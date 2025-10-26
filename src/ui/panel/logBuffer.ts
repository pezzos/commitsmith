import { CommitSmithUIBridge } from "./bridge";
import { StepId } from "../../shared/types";
import { SecretMasker } from "./security";

const MAX_LINES = 500;
const MAX_BYTES = 100 * 1024;
const FLUSH_INTERVAL_MS = 100;
const TRUNCATED_MARKER = "… truncated";

export class StepLogBuffer {
  private readonly bridge: CommitSmithUIBridge;
  private readonly step: StepId;
  private readonly masker: Pick<SecretMasker, "mask">;
  private lineCount = 0;
  private byteCount = 0;
  private truncated = false;
  private partial = "";
  private queue: string[] = [];
  private flushTimer: NodeJS.Timeout | undefined;

  constructor(
    step: StepId,
    bridge: CommitSmithUIBridge,
    masker: Pick<SecretMasker, "mask">,
  ) {
    this.step = step;
    this.bridge = bridge;
    this.masker = masker;
  }

  reset(): void {
    this.clearTimer();
    this.queue = [];
    this.partial = "";
    this.lineCount = 0;
    this.byteCount = 0;
    this.truncated = false;
    this.bridge.postMessage({
      type: "APPEND_LOG",
      payload: {
        step: this.step,
        chunk: "",
        truncated: false,
        timestamp: new Date().toISOString(),
        reset: true,
      },
    });
  }

  append(rawChunk: string): void {
    if (this.truncated || rawChunk.length === 0) {
      return;
    }
    const masked = this.masker.mask(rawChunk);
    let buffer = this.partial + masked;
    this.partial = "";
    const lines = buffer.split(/\r?\n/);
    for (let index = 0; index < lines.length - 1; index += 1) {
      if (!this.emitLine(`${lines[index]}\n`)) {
        return;
      }
    }
    const tail = lines[lines.length - 1];
    if (buffer.endsWith("\n")) {
      void this.emitLine(`${tail}\n`);
    } else {
      this.partial = tail;
    }
  }

  close(): void {
    if (this.truncated) {
      this.partial = "";
      this.flush();
      return;
    }
    if (this.partial.length > 0) {
      this.emitLine(this.partial);
      this.partial = "";
    }
    this.flush();
  }

  dispose(): void {
    this.clearTimer();
  }

  private emitLine(line: string): boolean {
    if (this.truncated || line.length === 0) {
      return false;
    }
    const bytes = Buffer.byteLength(line, "utf8");
    if (
      this.lineCount + 1 > MAX_LINES ||
      this.byteCount + bytes > MAX_BYTES
    ) {
      this.emitTruncated();
      return false;
    }
    this.lineCount += 1;
    this.byteCount += bytes;
    this.queue.push(line);
    this.scheduleFlush();
    return true;
  }

  private emitTruncated(): void {
    if (this.truncated) {
      return;
    }
    this.truncated = true;
    this.queue.push(`${TRUNCATED_MARKER}\n`);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flush();
    }, FLUSH_INTERVAL_MS);
  }

  private flush(): void {
    this.clearTimer();
    if (this.queue.length === 0) {
      return;
    }
    const chunk = this.queue.join("");
    this.queue = [];
    this.bridge.postMessage({
      type: "APPEND_LOG",
      payload: {
        step: this.step,
        chunk,
        truncated: this.truncated,
        timestamp: new Date().toISOString(),
      },
    });
  }

  private clearTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
  }
}
