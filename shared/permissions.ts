import type { Mode, Workspace } from "./types";
export function taskPermissions(
  workspace: Workspace,
  mode: Mode,
  planning = false,
) {
  if (workspace === "chat" || !planning)
    return workspacePermissions(workspace, mode);
  return [
    { action: "*", resource: "*", effect: "deny" as const },
    ...["read", "glob", "grep", "skill", "question", "todowrite"].map(
      (action) => ({ action, resource: "*", effect: "allow" as const }),
    ),
    ...["*.env", "*.env.*", "*credentials*", "*id_rsa*", "*id_ed25519*"].map(
      (resource) => ({ action: "read", resource, effect: "ask" as const }),
    ),
    { action: "external_directory", resource: "*", effect: "deny" as const },
  ];
}
export const PLAN_INSTRUCTIONS =
  "Planning mode is active. Inspect permitted project files, ask clarifying questions, and produce an actionable plan with validation steps. Do not change files, run commands, delegate changes, or call external tools. Wait for the user to leave planning mode before implementing.";
export function workspacePermissions(workspace: Workspace, mode: Mode) {
  // Catch-all applies to built-ins, subagents and dynamically connected tools.
  // No later allow rule may be added in Chat, including on mode changes.
  return workspace === "chat"
    ? [{ action: "*", resource: "*", effect: "deny" as const }]
    : permissionRules(mode);
}
export function permissionRules(mode: Mode) {
  const base: {
    action: string;
    resource: string;
    effect: "ask" | "allow" | "deny";
  }[] = [
    { action: "*", resource: "*", effect: mode === "full" ? "allow" : "ask" },
  ];
  if (mode !== "full") {
    for (const action of [
      "read",
      "glob",
      "grep",
      "skill",
      "question",
      "todowrite",
    ])
      base.push({ action, resource: "*", effect: "allow" });
    if (mode === "autonomous")
      for (const action of [
        "edit",
        "shell",
        "subagent",
        "webfetch",
        "websearch",
      ])
        base.push({ action, resource: "*", effect: "allow" });
    base.push({ action: "external_directory", resource: "*", effect: "ask" });
    for (const resource of [
      "git push*",
      "git *push*",
      "git *--force*",
      "gh pr create*",
      "gh repo delete*",
      "git *branch*-D*",
    ])
      base.push({ action: "shell", resource, effect: "ask" });
    for (const resource of [
      "*.env",
      "*.env.*",
      "*credentials*",
      "*id_rsa*",
      "*id_ed25519*",
    ])
      base.push({ action: "read", resource, effect: "ask" });
  }
  // Engine-spawned writers would share the parent's directory. RCF launches
  // independent writers through Agent Control in a distinct worktree instead.
  base.push({ action: "subagent", resource: "*", effect: "deny" });
  base.push({ action: "subagent", resource: "rcf-reader", effect: "allow" });
  return base;
}
