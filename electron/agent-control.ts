import path from "node:path";
import { createHash } from "node:crypto";
import type {
  OpenCodeClient,
  SessionInfo,
  SessionMessageInfo,
} from "@opencode/client";
import type { ModelRef, Session } from "../shared/types";
import type {
  AgentDefinition,
  AgentRun,
  ReviewReport,
  Checkpoint,
} from "../shared/rcf";
import { agentStatus, parseReview, REVIEW_INSTRUCTIONS } from "../shared/rcf";
import { WorkspaceGitService } from "./git";
import { WorktreeService, sameDirectory } from "./worktrees";
import { LocalStorage } from "./storage";
import type { SessionCoordinator } from "./coordinator";
import { taskPermissions } from "../shared/permissions";
import { diffLines } from "../shared/diff";

export const REVIEW_PERMISSIONS = [
  { action: "*", resource: "*", effect: "deny" as const },
];
export const READER_PERMISSIONS = [
  ...REVIEW_PERMISSIONS,
  ...["read", "glob", "grep"].map((action) => ({
    action,
    resource: "*",
    effect: "allow" as const,
  })),
  ...["*.env", "*.env.*", "*credentials*", "*id_rsa*", "*id_ed25519*"].map(
    (resource) => ({ action: "read", resource, effect: "deny" as const }),
  ),
  { action: "external_directory", resource: "*", effect: "deny" as const },
];
export class AgentControlService {
  readonly git = new WorkspaceGitService();
  constructor(
    readonly coordinator: SessionCoordinator,
    readonly storage: LocalStorage,
    readonly client: () => Promise<OpenCodeClient>,
    readonly worktrees: WorktreeService,
  ) {}
  async work(id: string) {
    const info = await this.coordinator.own(id);
    if (
      info.metadata?.forgeWorkspace === "chat" ||
      info.metadata?.rcfReviewSource
    )
      throw new Error(
        "Эта операция доступна только основной задаче Work Faction.",
      );
    return info;
  }
  async history(id: string): Promise<SessionMessageInfo[]> {
    const c = await this.client(),
      all: SessionMessageInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await c.message.list({
        sessionID: id,
        limit: 150,
        ...(cursor ? { cursor } : { order: "asc" as const }),
      });
      all.push(...page.data);
      cursor = page.cursor.next ?? undefined;
      if (all.length >= 6000 && cursor)
        throw new Error(
          "История больше 6000 сообщений. Откройте отдельную задачу для этой операции.",
        );
    } while (cursor);
    return all.sort(
      (a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id),
    );
  }
  async definitions(id: string): Promise<AgentDefinition[]> {
    const info = await this.work(id);
    return (
      await (await this.client()).agent.list({ location: info.location })
    ).data
      .filter((a) => !a.hidden)
      .map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description ?? "",
        mode: a.mode,
        model: a.model,
      }));
  }
  async children(id: string): Promise<AgentRun[]> {
    const parent = await this.coordinator.own(id),
      c = await this.client();
    if (parent.metadata?.forgeWorkspace === "chat") return [];
    const active = await c.session.active();
    const children: SessionInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await c.session.list({
        ...(cursor ? { cursor } : {}),
        parentID: id,
        limit: 100,
      });
      children.push(...page.data.filter((s) => s.parentID === id));
      cursor = page.cursor.next ?? undefined;
    } while (cursor);
    for (const reviewId of this.storage.get<string[]>(
      `rcf:reviews:${id}`,
      [],
    )) {
      if (children.some((s) => s.id === reviewId)) continue;
      const info = await c.session
        .get({ sessionID: reviewId })
        .catch(() => undefined);
      if (info?.metadata?.rcfReviewSource === id) children.push(info);
    }
    return Promise.all(
      children.map(async (info) => {
        const session = await this.coordinator.describe(
          info,
          !!active[info.id],
        );
        const page = await c.message.list({
          sessionID: info.id,
          limit: 150,
          order: "desc",
        });
        const assistant = page.data.filter((m) => m.type === "assistant");
        const result =
          assistant
            .find((m) => m.content.some((p) => p.type === "text"))
            ?.content.filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("\n") ?? "";
        const task = page.data.find((m) => m.type === "user");
        return {
          session,
          agent: info.agent ?? "Unknown",
          task:
            typeof info.metadata?.rcfTask === "string"
              ? info.metadata.rcfTask
              : (task?.text ?? info.title ?? ""),
          status: agentStatus(session),
          result: this.coordinator.engine.redactor.text(result),
          actions: assistant
            .flatMap((m) =>
              m.content.filter((p) => p.type === "tool").map((p) => p.name),
            )
            .slice(0, 8),
        };
      }),
    );
  }
  async launch(
    id: string,
    agentId: string,
    task: string,
    model?: ModelRef,
    directory?: string,
  ): Promise<Session> {
    const parent = await this.work(id),
      c = await this.client();
    const definition = (await this.definitions(id)).find(
      (a) => a.id === agentId,
    );
    if (!definition) throw new Error("Агент недоступен в OpenCode.");
    if (agentId === "rcf-reviewer")
      throw new Error("Запускайте Reviewer через Review changes.");
    const projectId = (await this.coordinator.describe(parent)).projectId;
    // Shared workspaces permit only an engine-enforced reader. All writers
    // must use another worktree, including when the parent is currently idle.
    const reader = agentId === "rcf-reader";
    const target = directory
      ? (await this.worktrees.select(projectId, directory)).directory
      : parent.location.directory;
    if (!reader && sameDirectory(target, parent.location.directory))
      throw new Error(
        "Для независимого агента выберите отдельный worktree. Для чтения доступен rcf-reader.",
      );
    if (!reader) await this.coordinator.assertWritable(target);
    const permissions = reader
      ? READER_PERMISSIONS
      : taskPermissions("work", "cautious");
    let info = await c.session.create({
      parentID: id,
      title: `${definition.name}: ${task.slice(0, 80)}`,
      agent: agentId,
      model: model ?? definition.model ?? parent.model,
      location: { directory: target },
      permissions,
      metadata: {
        forgeWorkspace: "work",
        forgeMode: "cautious",
        rcfTask: task,
        rcfReader: reader,
      },
    });
    // V2 child creation inherits the parent's location even with location set.
    // Move using the supported API before any prompt or tool can run.
    if (!sameDirectory(info.location.directory, target)) {
      await c.session.move({ sessionID: info.id, directory: target });
      await c.session.update({
        sessionID: info.id,
        permissions,
        metadata: info.metadata,
      });
      info = await c.session.get({ sessionID: info.id });
    }
    if (!sameDirectory(info.location.directory, target) || info.parentID !== id)
      throw new Error(
        "OpenCode не подтвердил рабочую папку дочерней сессии. Запуск отменён.",
      );
    await c.session.prompt({
      sessionID: info.id,
      text: task,
      delivery: "queue",
    });
    this.coordinator.changed(id);
    return this.coordinator.describe(info);
  }
  async material(source: SessionInfo) {
    const cwd = source.location.directory;
    const status = await this.git.status(cwd);
    const parts: string[] = [];
    const references: Record<string, number[]> = {};
    const omitted: string[] = [];
    const sensitive = (file: string) =>
      /(^|[\\/])(?:\.env(?:\..*)?|.*credentials.*|id_rsa.*|id_ed25519.*)$/i.test(
        file,
      );
    const include = (file: string, patch: string, prefix: string) => {
      if (sensitive(file)) {
        omitted.push(file);
        return;
      }
      references[file] = [
        ...new Set([
          ...(references[file] ?? []),
          ...diffLines(patch).flatMap((l) =>
            l.next === undefined ? [] : [l.next],
          ),
        ]),
      ];
      parts.push(`${prefix}\n${patch}`);
    };
    if (status.repository) {
      for (const file of status.files) {
        if (sensitive(file.path)) {
          omitted.push(file.path);
          continue;
        }
        include(
          file.path,
          await this.git.diff(cwd, file.path),
          `FILE ${JSON.stringify(file.path)} STATUS ${file.status}`,
        );
      }
    }
    // Committed task changes are still visible in the engine's task diff.
    const task = await (
      await this.client()
    ).session.diff({ sessionID: source.id });
    for (const d of task)
      include(
        d.file,
        d.patch,
        `SESSION FILE ${JSON.stringify(d.file)}${d.more ? " (PARTIAL)" : ""}`,
      );
    if (!parts.length) throw new Error("Нет доступных изменений для проверки.");
    const full = parts.join("\n\n");
    const fingerprint = createHash("sha256").update(full).digest("hex");
    return {
      fingerprint,
      references,
      omitted,
      text: this.coordinator.engine.redactor.text(full).slice(0, 180000),
      partial: full.length > 180000 || task.some((d) => d.more),
    };
  }
  async startReview(id: string, model: ModelRef): Promise<Session> {
    const source = await this.work(id),
      c = await this.client();
    if ((await c.session.active())[id])
      throw new Error("Дождитесь окончания основной задачи.");
    if (
      !(
        await this.coordinator.models(
          (await this.coordinator.describe(source)).projectId,
        )
      ).some(
        (m) =>
          m.enabled && m.id === model.id && m.providerID === model.providerID,
      )
    )
      throw new Error("Модель Reviewer недоступна.");
    const materials = await this.material(source);
    // Dedicated built-in configuration has zero tools. Session permissions
    // repeat this restriction and ordinary send/mode/permission IPC cannot relax it.
    // No engine parentID: completion of an engine child automatically resumes
    // its parent. Review must never restart the implementer without Fix consent.
    const info = await c.session.create({
      title: `Code Review · ${source.title ?? id}`,
      agent: "rcf-reviewer",
      model,
      location: source.location,
      permissions: REVIEW_PERMISSIONS,
      metadata: {
        forgeWorkspace: "work",
        forgeMode: "cautious",
        rcfReviewSource: id,
        rcfReviewFingerprint: materials.fingerprint,
        rcfReviewPartial: materials.partial,
        rcfReviewOmitted: materials.omitted,
      },
    });
    this.storage.set(`rcf:reviews:${id}`, [
      info.id,
      ...this.storage.get<string[]>(`rcf:reviews:${id}`, []),
    ]);
    this.storage.set(`rcf:review-lines:${info.id}`, materials.references);
    await c.session.prompt({
      sessionID: info.id,
      text: `${REVIEW_INSTRUCTIONS}\n\nTask: ${source.title ?? id}\nEvidence scope: ${materials.partial ? "PARTIAL: truncated at 180000 characters" : "Git working/staged/untracked and engine session diffs; surrounding files and tests not independently executed"}\n<untrusted-diff>\n${materials.text}\n</untrusted-diff>`,
      delivery: "queue",
    });
    this.coordinator.changed(id);
    return this.coordinator.describe(info);
  }
  async report(id: string): Promise<ReviewReport> {
    const info = await this.coordinator.own(id),
      sourceId = info.metadata?.rcfReviewSource;
    if (typeof sourceId !== "string")
      throw new Error("Это не сессия Code Review.");
    const source = await this.work(sourceId),
      c = await this.client();
    const messages = await this.history(id);
    const raw = this.coordinator.engine.redactor.text(
      messages
        .filter((m) => m.type === "assistant")
        .flatMap((m) =>
          m.content.filter((p) => p.type === "text").map((p) => p.text),
        )
        .join("\n"),
    );
    const status = agentStatus(
      await this.coordinator.describe(info, !!(await c.session.active())[id]),
    );
    const material = await this.material(source).catch(() => undefined);
    const parsed = parseReview(raw);
    parsed.limitations.push(...messages.filter(m=>m.type==='assistant'&&m.error).map(m=>m.type==='assistant' ? `Execution error: ${this.coordinator.engine.redactor.text(m.error!.message)}` : ''));
    const references = this.storage.get<Record<string, number[]>>(
      `rcf:review-lines:${id}`,
      {},
    );
    parsed.issues = parsed.issues?.map((issue) => {
      if (
        issue.line !== undefined &&
        !references[issue.file]?.includes(issue.line)
      ) {
        const { line, ...withoutLine } = issue;
        parsed.limitations.push(
          `Unverified line reference omitted: ${issue.file}:${line}`,
        );
        return withoutLine;
      }
      return issue;
    });
    return {
      sessionId: id,
      sourceId,
      status,
      ...parsed,
      issues: status === "Completed" ? parsed.issues : undefined,
      raw,
      stale:
        !material ||
        material.fingerprint !== info.metadata?.rcfReviewFingerprint,
      limitations: [
        ...parsed.limitations,
        "Evidence-only review: no commands or tests executed by Reviewer; complete source context may be unavailable.",
        ...(info.metadata?.rcfReviewPartial
          ? ["Diff is partial or truncated."]
          : []),
        ...(Array.isArray(info.metadata?.rcfReviewOmitted) &&
        info.metadata.rcfReviewOmitted.length
          ? [
              `Sensitive file paths excluded: ${info.metadata.rcfReviewOmitted.join(", ")}`,
            ]
          : []),
      ],
    };
  }
  async fix(id: string) {
    const report = await this.report(id);
    if (report.status !== "Completed" || !report.issues?.length || report.stale)
      throw new Error("Нужен завершённый актуальный отчёт с замечаниями.");
    const source = await this.work(report.sourceId);
    if (!source.model) throw new Error("Выберите модель основной задачи.");
    await this.coordinator.send(
      source.id,
      `Исправь подтверждённые замечания независимой проверки. Проверь их обоснованность, затем выполни подходящие тесты. Не запускай повторное ревью автоматически.\n${JSON.stringify(report.issues, null, 2)}`,
      source.model,
      "cautious",
      [],
    );
  }
  async checkpoints(id: string): Promise<Checkpoint[]> {
    await this.coordinator.own(id);
    return (await this.history(id)).flatMap<Checkpoint>((m) =>
      m.type === "user"
        ? [
            {
              messageId: m.id,
              at: m.time.created,
              title: m.text.slice(0, 100),
              files: [],
              snapshot: false,
            },
          ]
        : m.type === "assistant" && m.snapshot
          ? [
              {
                messageId: m.id,
                at: m.time.created,
                title: "OpenCode snapshot",
                files: m.snapshot.files ?? [],
                snapshot: true,
              },
            ]
          : [],
    );
  }
  async restoreHistory(id: string, messageId: string) {
    await this.work(id);
    const c = await this.client();
    if (
      (await c.session.active())[id] ||
      (await c.session.inbox.list({ sessionID: id })).length
    )
      throw new Error("Сначала остановите задачу и очистите очередь.");
    if (!(await this.checkpoints(id)).some((p) => p.messageId === messageId))
      throw new Error("Точка восстановления не найдена.");
    // files:false intentionally restores session history only. Engine snapshots
    // cannot establish ownership of unrelated dirty files, so never revert them.
    await c.session.revert.stage({
      sessionID: id,
      messageID: messageId,
      files: false,
    });
    try {
      await c.session.revert.commit({ sessionID: id });
    } catch (e) {
      await c.session.revert.clear({ sessionID: id }).catch(() => {});
      throw e;
    }
    this.coordinator.forget(id);
    this.coordinator.changed(id);
  }
}
