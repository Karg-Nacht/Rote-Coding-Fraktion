import type { ActionFileDiff } from "../shared/types";
import { fileDisplayPaths } from "./activity-path";

// OpenCode tool results carry operation-level evidence in metadata.files.
// A session diff is a different scope and should never be attributed to a tool.
export function actionDiffs(
  name: string,
  input: Record<string, unknown>,
  metadata: Record<string, unknown>,
  redact: (text: string) => string,
  directory?: string,
): ActionFileDiff[] {
  const changes: ActionFileDiff[] = [];
  const moves =
    typeof input.patchText === "string"
      ? [
          ...input.patchText.matchAll(
            /^\*\*\* Update File: (.+)\r?\n(?:\*\*\* End of File\r?\n)*\*\*\* Move to: (.+)$/gm,
          ),
        ]
      : [];
  if (Array.isArray(metadata.files)) {
    for (const value of metadata.files) {
      if (!value || typeof value !== "object") continue;
      const data: Record<string, unknown> = value;
      const file = data.file ?? data.relativePath ?? data.filePath;
      if (typeof file !== "string" || !file.trim()) continue;
      const patch = typeof data.patch === "string" ? data.patch : "";
      const previousFile =
        /^rename from (.+)$/m.exec(patch)?.[1]?.trim() ??
        moves
          .find(([, , destination]) => {
            const to = normalizedPath(destination);
            const result = normalizedPath(file);
            return result === to || result.endsWith(`/${to}`);
          })?.[1]
          .trim();
      changes.push({
        file: redact(file),
        ...fileDisplayPaths(file, directory, redact),
        patch: redact(patch),
        status: previousFile
          ? "renamed"
          : typeof data.status === "string"
            ? data.status
            : "modified",
        previousFile: previousFile ? redact(previousFile) : undefined,
        additions: count(data.additions),
        deletions: count(data.deletions),
        more: data.more === true || undefined,
      });
    }
  }
  if (!changes.length && (name === "edit" || name === "write")) {
    const file = input.path ?? input.filePath;
    if (typeof file === "string" && file.trim())
      changes.push({
        file: redact(file),
        ...fileDisplayPaths(file, directory, redact),
        patch: typeof metadata.diff === "string" ? redact(metadata.diff) : "",
        status: name === "edit" ? "modified" : "written",
      });
  }
  return changes;
}

const normalizedPath = (file: string) =>
  file.trim().replaceAll("\\", "/").replace(/^\.\//, "");

function count(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}
