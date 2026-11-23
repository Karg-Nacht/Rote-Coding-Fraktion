import type { TimelineRow, ToolItem } from "./types";

export function toolState(tool: ToolItem) {
  if (tool.status === "running" || tool.status === "streaming")
    return "running";
  if (tool.status === "killed" || tool.status === "interrupted")
    return "interrupted";
  if (
    tool.status === "error" ||
    tool.status === "timeout" ||
    (tool.category === "shell" && tool.exit !== undefined && tool.exit !== "0")
  )
    return "error";
  if (tool.status === "completed" || tool.status === "exited")
    return "completed";
  return "unknown";
}

export type ActivityKind = ToolItem["category"] | "check";

export function activityKind(tool: ToolItem): ActivityKind {
  if (tool.category === "image") return "read";
  if (["test", "run_tests", "verify", "diagnostics"].includes(tool.name))
    return "check";
  if (tool.category !== "shell" || !tool.command) return tool.category;
  const command = tool.command.trim();
  // Only explicit invocations qualify. Descriptions and mentions in shell
  // arguments (such as echo "npm test") are not evidence of a check.
  const check =
    /^(?:pytest|vitest|jest|eslint|ruff\s+check|tsc\s+--noEmit)(?=\s|$)/i.test(
      command,
    ) ||
    /^(?:npm(?:\.cmd)?|pnpm(?:\.cmd)?|yarn(?:\.cmd)?|bun)\s+(?:(?:run|exec)\s+)?(?:test(?:[:\w-]+)?|lint|typecheck|check)(?=\s|$)/i.test(
      command,
    ) ||
    /^(?:cargo\s+(?:test|check|clippy)|go\s+(?:test|vet)|dotnet\s+test|python(?:3)?\s+-m\s+(?:pytest|unittest)|node\s+--test)(?=\s|$)/i.test(
      command,
    );
  return check ? "check" : "shell";
}

export function activityGroups(tools: ToolItem[]) {
  const groups: { kind: ActivityKind; id: string; tools: ToolItem[] }[] = [];
  for (const tool of tools) {
    const kind = activityKind(tool);
    const previous = groups.at(-1);
    if (previous?.kind === kind) previous.tools.push(tool);
    else groups.push({ kind, id: tool.id, tools: [tool] });
  }
  return groups;
}

export function activityRows(rows: TimelineRow[], hidden: boolean) {
  return hidden
    ? rows.filter(
        (row) =>
          row.type !== "actions" ||
          row.tools.some((tool) => toolState(tool) !== "completed"),
      )
    : rows;
}
