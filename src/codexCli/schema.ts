import path from "node:path";
import { readFileSync } from "node:fs";

import Ajv, { ErrorObject, ValidateFunction } from "ajv";

export interface CodexSchemaIssue {
  readonly path: string;
  readonly message: string;
}

export class CodexSchemaValidationError extends Error {
  readonly schemaId: string;
  readonly issues: CodexSchemaIssue[];

  constructor(schemaId: string, issues: CodexSchemaIssue[]) {
    const formatted =
      issues.length > 0
        ? issues
            .map((issue) => `${issue.path}: ${issue.message}`)
            .join("; ")
        : "unknown issue";
    super(
      `Codex CLI response did not match schema ${schemaId}: ${formatted}`,
    );
    this.name = "CodexSchemaValidationError";
    this.schemaId = schemaId;
    this.issues = issues;
  }
}

export interface CodexSchemaValidator<T> {
  readonly id: string;
  readonly version: string;
  parse(value: unknown): T;
}

const ajv = new Ajv({ allErrors: true, strict: false });
const validatorCache = new Map<string, ValidateFunction<unknown>>();

interface SchemaDescriptor<T> {
  readonly id: string;
  readonly file: string;
  readonly version: string;
}

const BASE_DIR = path.resolve(__dirname, "..", "..");
const SCHEMAS: Record<"commit" | "fix", SchemaDescriptor<unknown>> = {
  commit: {
    id: "codex-cli-commit.v1",
    file: "assets/schema/codex-cli-commit.v1.schema.json",
    version: "v1",
  },
  fix: {
    id: "codex-cli-fix.v1",
    file: "assets/schema/codex-cli-fix.v1.schema.json",
    version: "v1",
  },
};

function loadSchema(schemaFile: string): ValidateFunction<unknown> {
  const absolutePath = path.join(BASE_DIR, schemaFile);
  if (validatorCache.has(absolutePath)) {
    return validatorCache.get(absolutePath)!;
  }
  const raw = readFileSync(absolutePath, "utf8");
  const schema = JSON.parse(raw);
  const validate = ajv.compile<unknown>(schema);
  validatorCache.set(absolutePath, validate);
  return validate;
}

function formatAjvError(error: ErrorObject): CodexSchemaIssue {
  const pathSegments = Array.isArray(error.instancePath)
    ? error.instancePath
    : error.instancePath.split("/").filter(Boolean);
  let jsonPath =
    pathSegments.length === 0
      ? "response"
      : `response.${pathSegments.join(".")}`;

  if (
    error.keyword === "required" &&
    error.params &&
    typeof (error.params as { missingProperty?: string })
      .missingProperty === "string"
  ) {
    const missing = (error.params as { missingProperty: string })
      .missingProperty;
    jsonPath =
      jsonPath === "response"
        ? `response.${missing}`
        : `${jsonPath}.${missing}`;
  }

  return {
    path: jsonPath,
    message: error.message ?? "Invalid value",
  };
}

function buildValidator<T>(
  descriptor: SchemaDescriptor<T>,
): CodexSchemaValidator<T> {
  const validate = loadSchema(descriptor.file);
  return {
    id: descriptor.id,
    version: descriptor.version,
    parse(value: unknown): T {
      if (validate(value)) {
        return value as T;
      }

      const issues = (validate.errors ?? []).map(formatAjvError);
      throw new CodexSchemaValidationError(descriptor.id, issues);
    },
  };
}

let commitValidator: CodexSchemaValidator<any> | undefined;
let fixValidator: CodexSchemaValidator<any> | undefined;

export function getCommitSchemaValidator<
  T,
>(): CodexSchemaValidator<T> {
  if (!commitValidator) {
    commitValidator = buildValidator<T>(SCHEMAS.commit);
  }
  return commitValidator;
}

export function getFixSchemaValidator<T>(): CodexSchemaValidator<T> {
  if (!fixValidator) {
    fixValidator = buildValidator<T>(SCHEMAS.fix);
  }
  return fixValidator;
}
