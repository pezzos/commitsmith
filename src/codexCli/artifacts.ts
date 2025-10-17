import path from "node:path";
import { promises as fs } from "node:fs";

export interface CodexCliArtifact {
  readonly kind: "commit" | "fix";
  readonly schemaId: string;
  readonly prompt: string;
  readonly promptSummary: string;
  readonly rawEvents: string[];
  readonly result?: unknown;
  readonly error?: {
    readonly message: string;
    readonly issues?: ReadonlyArray<{
      readonly path: string;
      readonly message: string;
    }>;
  };
  readonly context?: Record<string, unknown>;
}

export type CodexCliArtifactRecorder = (
  artifact: CodexCliArtifact,
) => Promise<void>;

export function createCliArtifactRecorder(
  baseDir: string,
): CodexCliArtifactRecorder {
  let fixCounter = 0;
  let commitCounter = 0;
  const root = path.join(baseDir, "cli");

  return async (artifact: CodexCliArtifact) => {
    const label =
      artifact.kind === "commit"
        ? `commit-${String(++commitCounter).padStart(2, "0")}`
        : `fix-${String(++fixCounter).padStart(2, "0")}`;

    const directory = path.join(root, label);
    await fs.mkdir(directory, { recursive: true });

    await fs.writeFile(
      path.join(directory, "prompt.txt"),
      artifact.prompt,
      "utf8",
    );

    if (artifact.rawEvents.length > 0) {
      const jsonl = `${artifact.rawEvents.join("\n")}\n`;
      await fs.writeFile(
        path.join(directory, "raw.jsonl"),
        jsonl,
        "utf8",
      );
    } else {
      await fs.writeFile(
        path.join(directory, "raw.jsonl"),
        "",
        "utf8",
      );
    }

    await fs.writeFile(
      path.join(directory, "result.json"),
      JSON.stringify(artifact.result ?? null, null, 2),
      "utf8",
    );

    const meta = {
      schemaId: artifact.schemaId,
      promptSummary: artifact.promptSummary,
      context: artifact.context ?? undefined,
      error: artifact.error ?? undefined,
    };

    await fs.writeFile(
      path.join(directory, "meta.json"),
      JSON.stringify(meta, null, 2),
      "utf8",
    );
  };
}
