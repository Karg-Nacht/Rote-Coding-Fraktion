import fs from "node:fs/promises";
import path from "node:path";
import type { OpenCodeClient } from "@opencode/client";
import type { Worktree } from "../shared/rcf";
import { WorkspaceGitService } from "./git";
import { LocalStorage } from "./storage";

export const sameDirectory = (a: string, b: string) =>
  process.platform === "win32"
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b);
export class WorktreeService {
  constructor(
    readonly storage: LocalStorage,
    readonly client: () => Promise<OpenCodeClient>,
    readonly git = new WorkspaceGitService(),
  ) {}
  async list(projectId: string): Promise<Worktree[]> {
    const root = this.storage.project(projectId).path;
    const rootStatus = await this.git.status(root);
    if (rootStatus.error) throw new Error(rootStatus.error);
    if (!rootStatus.repository) return [];
    // Git also discovers existing worktrees created outside OpenCode.
    const raw = await this.git.run(root, [
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    const records = raw.split("\0\0").filter(Boolean);
    return Promise.all(
      records.map(async (record, i) => {
        const fields = record.split("\0");
        const directory = fields
          .find((f) => f.startsWith("worktree "))!
          .slice(9);
        const status = await this.git
          .run(directory, [
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
            "--ignored",
          ])
          .catch(() => "?");
        return {
          directory,
          branch:
            fields
              .find((f) => f.startsWith("branch "))
              ?.slice(7)
              .replace(/^refs\/heads\//, "") ?? "(detached HEAD)",
          main: i === 0,
          dirty: !!status.trim(),
          locked: fields.some((f) => f.startsWith("locked")),
        };
      }),
    );
  }
  async select(projectId: string, directory: string) {
    const item = (await this.list(projectId)).find((w) =>
      sameDirectory(w.directory, directory),
    );
    if (!item)
      throw new Error(
        "Worktree больше не принадлежит проекту. Обновите список.",
      );
    const canonical = await fs.realpath(item.directory);
    this.storage.bindDirectory(projectId, canonical);
    return { ...item, directory: canonical };
  }
  async create(projectId: string, branch: string) {
    const root = this.storage.project(projectId).path;
    if (!(await this.git.status(root)).repository)
      throw new Error("Выберите Git-проект.");
    if (
      !/^rcf\/[a-zA-Z0-9][a-zA-Z0-9._/-]{0,100}$/.test(branch) ||
      branch.includes("..") ||
      branch.endsWith("/")
    )
      throw new Error("Имя ветки: rcf/task-name.");
    await this.git.run(root, ["check-ref-format", "--branch", branch]);
    const c = await this.client();
    const location = await c.location.get({ location: { directory: root } });
    // V2 branch selects an existing ref; it does not create that branch.
    // Git supplies only this missing primitive; OpenCode owns worktree creation.
    await this.git.run(root, ["branch", "--", branch, "HEAD"]);
    const result = await c.worktree.create({
      projectID: location.project.id,
      from: root,
      branch,
      name: branch.slice(4).replaceAll("/", "-"),
    });
    // OpenCode 2.3.0 checks out the selected ref detached. Attach the freshly
    // created branch explicitly; never switch the source worktree.
    await this.git.run(result.directory, ["switch", "--", branch]);
    // Never retry mutations with another backend after an ambiguous API failure.
    return this.select(projectId, result.directory);
  }
  async assertRemovable(projectId: string, directory: string) {
    const item = (await this.list(projectId)).find((w) =>
      sameDirectory(w.directory, directory),
    );
    if (
      !item ||
      item.main ||
      item.locked ||
      sameDirectory(item.directory, this.storage.project(projectId).path)
    )
      throw new Error(
        "Основную или заблокированную рабочую папку удалить нельзя.",
      );
    if (item.dirty)
      throw new Error(
        "Worktree содержит несохранённые или игнорируемые файлы. Сохраните их перед удалением.",
      );
    const c = await this.client();
    const active = await c.session.active();
    for (const id of Object.keys(active)) {
      const info = await c.session.get({ sessionID: id });
      if (sameDirectory(info.location.directory, item.directory))
        throw new Error("Сначала остановите агентов этого worktree.");
    }
    return item;
  }
  async remove(projectId: string, directory: string) {
    const item = await this.assertRemovable(projectId, directory);
    // Deliberately use the non-force Git primitive: OpenCode remove supports force
    // and lifecycle hooks. RCF must preserve branches and reject ignored files.
    await this.git.run(this.storage.project(projectId).path, [
      "worktree",
      "remove",
      "--",
      item.directory,
    ]);
  }
}
