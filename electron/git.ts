import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import type { GitStatus, GitFile } from "../shared/types";
import { safeFile, contained } from "./security";
const runFile = promisify(execFile);
export class WorkspaceGitService {
  async run(cwd: string, args: string[], executable = "git"): Promise<string> {
    const { stdout } = await runFile(executable, args, {
      cwd,
      windowsHide: true,
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GH_PROMPT_DISABLED: "1",
        GIT_OPTIONAL_LOCKS: "0",
      },
    });
    return stdout;
  }
  async status(cwd: string): Promise<GitStatus> {
    let error: string | undefined;
    const repository = await this.run(cwd, [
      "rev-parse",
      "--show-toplevel",
    ]).then(
      () => true,
      (e) => {
        if (!/not a git repository/i.test(String(e.stderr ?? e.message)))
          error = String(e.stderr || e.message).slice(0, 2000);
        return false;
      },
    );
    if (!repository)
      return { repository: false, branch: "", files: [], gh: false, error };
    const [branch, porcelain, stats, stagedStats, ghAccount] =
      await Promise.all([
        this.run(cwd, ["branch", "--show-current"]),
        this.run(cwd, [
          "-c",
          "core.quotepath=false",
          "status",
          "--porcelain=v1",
          "-z",
        ]),
        this.run(cwd, ["diff", "--numstat", "-z"]),
        this.run(cwd, ["diff", "--cached", "--numstat", "-z"]),
        this.run(cwd, ["api", "user", "--jq", ".login"], "gh").catch(() => ""),
      ]);
    const files: GitFile[] = [];
    const tokens = porcelain.split("\0");
    for (let i = 0; i < tokens.length; i++) {
      const row = tokens[i];
      if (!row) continue;
      const status = row.slice(0, 2),
        file = row.slice(3);
      files.push({ path: file, status });
      if (/[RC]/.test(status)) i++;
    }
    for (const row of `${stats}\0${stagedStats}`.split("\0")) {
      const [a, d, file] = row.split("\t");
      const found = files.find((f) => f.path === file);
      if (found && /^\d+$/.test(a) && /^\d+$/.test(d)) {
        found.additions = (found.additions ?? 0) + Number(a);
        found.deletions = (found.deletions ?? 0) + Number(d);
      }
    }
    return {
      repository,
      branch: branch.trim() || "(detached HEAD)",
      files,
      gh: !!ghAccount.trim(),
      ghAccount: ghAccount.trim() || undefined,
    };
  }
  async diff(cwd: string, file: string) {
    if (
      !file ||
      path.isAbsolute(file) ||
      !contained(cwd, path.resolve(cwd, file)) ||
      file.includes("\0")
    )
      throw new Error("Недопустимый путь diff.");
    // Use Git literal pathspecs so names such as :(top)** cannot widen the request.
    const spec = `:(literal)${file}`;
    const [working, staged] = await Promise.all([
      this.run(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--", spec]),
      this.run(cwd, [
        "diff",
        "--cached",
        "--no-ext-diff",
        "--no-textconv",
        "--",
        spec,
      ]),
    ]);
    if (working || staged)
      return `${staged ? `# В индексе\n${staged}` : ""}${working ? `\n# Рабочая папка\n${working}` : ""}`;
    const target = await safeFile(cwd, file);
    const info = await fs.stat(target);
    if (info.size > 2 * 1024 * 1024)
      return "Новый файл больше 2 МБ. Просмотр содержимого ограничен.";
    const buffer = await fs.readFile(target);
    if (buffer.includes(0)) return "Бинарный файл";
    return `--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${buffer.toString("utf8").split("\n").length} @@\n${buffer
      .toString("utf8")
      .split("\n")
      .map((l) => `+${l}`)
      .join("\n")}`;
  }
  async action(
    cwd: string,
    action: string,
    value: string,
    body = "",
  ): Promise<string> {
    if (action === "branch") {
      if (!value || value.startsWith("-"))
        throw new Error("Введите имя ветки.");
      await this.run(cwd, ["check-ref-format", "--branch", value]);
      return this.run(cwd, ["switch", "-c", value]);
    }
    if (action === "commit") {
      if (!value.trim()) throw new Error("Введите сообщение коммита.");
      // Commit only what the user has explicitly staged in the Git panel.
      return this.run(cwd, ["commit", "-m", value]);
    }
    if (action === "push") return this.run(cwd, ["push"]);
    if (action === "pull") return this.run(cwd, ["pull", "--ff-only"]);
    if (action === "pr") {
      if (!value.trim()) throw new Error("Введите заголовок Pull Request.");
      const temp = path.join(
        process.env.TEMP ?? cwd,
        `forge-pr-${crypto.randomUUID()}.txt`,
      );
      await fs.writeFile(temp, body, "utf8");
      try {
        return await this.run(
          cwd,
          ["pr", "create", "--draft", "--title", value, "--body-file", temp],
          "gh",
        );
      } finally {
        await fs.unlink(temp).catch(() => {});
      }
    }
    throw new Error("Неизвестная операция Git.");
  }
  async stage(cwd: string, files: string[]) {
    for (const file of files)
      if (path.isAbsolute(file) || !contained(cwd, path.resolve(cwd, file)))
        throw new Error("Недопустимый путь.");
    return this.run(cwd, ["add", "--", ...files.map((f) => `:(literal)${f}`)]);
  }
}
