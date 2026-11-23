import type {
  OpenCodeClient,
  SessionInfo,
  SessionMessageInfo,
} from "@opencode/client";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AppEvent,
  Mode,
  ModelRef,
  Session,
  Snapshot,
  Integration,
  Model,
  SavedProviderSettings,
  EditMessageResult,
  Workspace,
  SearchResult,
  PromptOptions,
  Capabilities,
} from "../shared/types";
import { LocalStorage } from "./storage";
import { OpenCodeSupervisor } from "./supervisor";
import { MediaService } from "./media";
import { normalizeTimeline } from "./timeline";
import { fileDisplayPaths } from "./activity-path";
import {
  workspacePermissions,
  taskPermissions,
  PLAN_INSTRUCTIONS,
} from "../shared/permissions";
import {
  CHAT_INSTRUCTIONS,
  containsSecret,
  memoryContext,
  searchableMessage,
  searchSnippet,
  workspaceOf,
} from "../shared/workspaces";
import { LiveProjection } from "./live";
import { safeExternal } from "./security";
import { sameDirectory } from "./worktrees";
import { sessionMetrics } from "./metrics";

const providerRuntimes = new Map<string, SavedProviderSettings["runtime"]>([
  ["@opencode/ai/providers/openai-compatible", "compatible"],
  ["@opencode/ai/providers/openai", "openai"],
  ["@opencode/ai/providers/anthropic", "anthropic"],
  ["@opencode/ai/providers/openrouter", "openrouter"],
]);

export class SessionCoordinator {
  private controller?: AbortController;
  private selected = new Set<string>();
  private stopped = false;
  private refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private cache = new Map<string, SessionInfo>();
  private messages = new Map<string, SessionMessageInfo[]>();
  private cursors = new Map<string, string | null | undefined>();
  private seen = new Set<string>();
  private loading = new Map<string, Promise<Snapshot>>();
  private listenTask?: Promise<void>;
  private live = new LiveProjection();
  private snapshots = new Map<string, Snapshot>();
  private editing = new Set<string>();
  private liveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private searchController?: AbortController;
  private retryStopped = new Set<string>();
  constructor(
    readonly storage: LocalStorage,
    readonly engine: OpenCodeSupervisor,
    readonly media: MediaService,
    private emit: (event: AppEvent) => void,
  ) {}
  async start() {
    if (this.listenTask) return;
    this.stopped = false;
    await this.engine.ensure();
    if (this.engine.status.compatibility?.checks.some(
      (check) => check.feature === "stream" && check.state === "verified",
    )) this.listenTask = this.listen();
  }
  async close() {
    this.stopped = true;
    this.controller?.abort();
    this.searchController?.abort();
    for (const timer of [
      ...this.refreshTimers.values(),
      ...this.liveTimers.values(),
    ])
      clearTimeout(timer);
    this.refreshTimers.clear();
    this.liveTimers.clear();
    this.selected.clear();
    this.retryStopped.clear();
    await this.listenTask;
    this.listenTask = undefined;
    this.live.clear();
    await Promise.allSettled(this.loading.values());
    this.cache.clear();
    this.messages.clear();
    this.cursors.clear();
    this.seen.clear();
    this.snapshots.clear();
    await this.engine.stop();
  }
  private async client() {
    return this.engine.ensure();
  }
  private projectFor(info: SessionInfo) {
    const normalize = (p: string) =>
      process.platform === "win32"
        ? path.resolve(p).toLowerCase()
        : path.resolve(p);
    return this.storage
      .projects()
      .find(
        (p) =>
          normalize(p.path) === normalize(info.location.directory) ||
          this.storage
            .taskDirectories(p.id)
            .some((d) => normalize(d) === normalize(info.location.directory)),
      );
  }
  async own(id: string): Promise<SessionInfo> {
    const info = await (await this.client()).session.get({ sessionID: id });
    if (!this.projectFor(info))
      throw new Error("Сессия не принадлежит добавленному проекту.");
    this.cache.set(id, info);
    return info;
  }
  private dto(info: SessionInfo, running = false): Session {
    const project = this.projectFor(info);
    if (!project) throw new Error("Проект сессии недоступен.");
    const mode = info.metadata?.forgeMode;
    return {
      id: info.id,
      parentId: info.metadata?.forgeSidebarFork ? undefined : info.parentID,
      projectId: project.id,
      title: info.title ?? "Новая задача",
      created: info.time.created,
      updated: info.time.updated,
      busy: info.time.busy,
      idle: info.time.idle,
      outcome: info.outcome,
      model: info.model,
      mode: mode === "autonomous" || mode === "full" ? mode : "cautious",
      workspace: workspaceOf(info),
      pinned: this.storage.pinned(info.id),
      running,
      planning: info.metadata?.forgePlanning === true,
      directory: info.location.directory,
      agent: info.agent,
      reviewSourceId:
        typeof info.metadata?.rcfReviewSource === "string"
          ? info.metadata.rcfReviewSource
          : undefined,
      completed: info.metadata?.rcfCompleted === true,
      ...this.storage.chatMeta(info.id),
    };
  }
  describe(info: SessionInfo, running = false): Session {
    return this.dto(info, running);
  }
  async assertWritable(directory: string, except?: string) {
    const client = await this.client();
    const active = await client.session.active();
    for (const id of Object.keys(active)) {
      if (id === except) continue;
      const info = await client.session.get({ sessionID: id });
      if (
        sameDirectory(info.location.directory, directory) &&
        info.metadata?.forgeWorkspace !== "chat" &&
        !info.metadata?.rcfReviewSource &&
        !info.metadata?.rcfReader &&
        !info.metadata?.forgePlanning
      )
        throw new Error(
          "В этой рабочей папке уже работает агент. Остановите его или выберите отдельный worktree.",
        );
    }
  }
  async list(projectId: string, cursor?: string, archived = false) {
    const project = this.storage.project(projectId);
    const client = await this.client();
    const [list, active] = await Promise.all([
      client.session.list(
        cursor
          ? { cursor, limit: 100 }
          : {
              directory: this.storage.taskDirectories(projectId).length
                ? undefined
                : project.path,
              limit: 100,
              order: "desc",
              archived,
            },
      ),
      client.session.active(),
    ]);
    const sessions = list.data
      .filter((s) => this.projectFor(s)?.id === projectId)
      .map((s) => {
        this.cache.set(s.id, s);
        return this.dto(s, !!active[s.id]);
      });
    return { sessions, next: list.cursor.next };
  }
  async create(
    projectId: string,
    model: ModelRef | undefined,
    mode: Mode,
    workspace: Workspace = "work",
    directory?: string,
  ): Promise<Session> {
    const project = this.storage.project(projectId);
    const info = await (
      await this.client()
    ).session.create({
      location: { directory: directory ?? project.path },
      model,
      permissions: workspacePermissions(workspace, mode),
      metadata: { forgeMode: mode, forgeWorkspace: workspace },
    });
    this.cache.set(info.id, info);
    this.emit({ type: "changed", sessionId: info.id });
    return this.dto(info);
  }
  async snapshot(id: string, older?: string): Promise<Snapshot> {
    const pending = this.loading.get(id);
    if (pending && !older) return pending;
    const task = this.load(id, older);
    this.loading.set(id, task);
    try {
      return await task;
    } finally {
      if (this.loading.get(id) === task) this.loading.delete(id);
    }
  }
  private async load(id: string, older?: string): Promise<Snapshot> {
    const info = await this.own(id),
      client = await this.client();
    const directoryMissing = await fs.stat(info.location.directory).then(
      (s) => !s.isDirectory(),
      (e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT" || e.code === "ENOTDIR") return true;
        throw e;
      },
    );
    const [page, active, permissions, forms, inbox] = await Promise.all([
      client.message.list({
        sessionID: id,
        limit: 150,
        ...(older ? { cursor: older } : { order: "desc" as const }),
      }),
      client.session.active(),
      directoryMissing || !this.engine.supports("session.permission.list")
        ? Promise.resolve([])
        : client.permission.list({ sessionID: id }),
      directoryMissing || !this.engine.supports("session.form.list") || !this.engine.supports("session.form.get")
        ? Promise.resolve([])
        : client.session.form.list({ sessionID: id }),
      directoryMissing || !this.engine.supports("session.inbox.list")
        ? Promise.resolve([])
        : client.session.inbox.list({ sessionID: id }),
    ]);
    // Retain already loaded pages; API snapshots replace duplicate message IDs.
    const existing = this.messages.get(id) ?? [];
    const byId = new Map(existing.map((m) => [m.id, m]));
    for (const message of page.data)
      byId.set(message.id, this.safeMessage(message));
    const messages = [...byId.values()].sort(
      (a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id),
    );
    this.messages.set(id, messages);
    const hasGap =
      page.data.length === 150 &&
      existing.length > 0 &&
      !page.data.some((message) =>
        existing.some((old) => old.id === message.id),
      );
    if (older || !this.cursors.has(id) || hasGap)
      this.cursors.set(id, page.data.length === 150 ? page.cursor.next : null);
    await this.media.prepare(messages, info.location.directory, client);
    const detailed = await Promise.all(
      forms.map((f) =>
        client.session.form.get({ sessionID: id, formID: f.id }),
      ),
    );
    const diffs = directoryMissing || !this.engine.supports("session.diff")
      ? []
      : !active[id]
        ? await client.session.diff({ sessionID: id })
        : (this.snapshots.get(id)?.diffs ?? []);
    const metrics = sessionMetrics(
      info,
      messages,
      this.cursors.get(id) != null,
    );
    metrics.errors = metrics.errors.map((error) =>
      this.engine.redactor.text(error),
    );
    const snapshot: Snapshot = {
      session: { ...this.dto(info, !!active[id]), directoryMissing },
      rows: normalizeTimeline(
        this.live.merge(id, messages),
        (uri) => this.media.resolve(info.location.directory, uri),
        (text) => this.engine.redactor.text(text),
        !!active[id],
        info.location.directory,
      ),
      permissions: permissions.map((p) => ({
        id: p.id,
        sessionId: id,
        action: p.action,
        resources: p.resources,
        toolId: p.source?.id,
      })),
      forms: detailed
        .filter((f) => f.state.status === "pending")
        .map((f) => ({
          id: f.id,
          sessionId: id,
          title: f.title,
          fields: f.fields,
        })),
      olderCursor: this.cursors.get(id),
      queued: inbox
        .filter((i) => i.type === "user")
        .map((i) => ({
          id: i.id,
          text: i.type === "user" ? i.payload.text : "",
        })),
      diffs: diffs.map((diff) => ({
        ...diff,
        ...fileDisplayPaths(diff.file, info.location.directory, (text) => this.engine.redactor.text(text)),
        patch: this.engine.redactor.text(diff.patch),
      })),
      metrics,
    };
    this.snapshots.set(id, snapshot);
    return snapshot;
  }
  async open(id: string) {
    this.selected.add(id);
    this.storage.setChatMeta(id, { unread: false });
    const snapshot = await this.snapshot(id);
    this.storage.savePreferences({
      sessionId: id,
      projectId: snapshot.session.projectId,
      workspace: snapshot.session.workspace ?? "work",
      workspaceSessions: {
        ...this.storage.preferences().workspaceSessions,
        [snapshot.session.workspace ?? "work"]: id,
      },
    });
    return snapshot;
  }
  forget(id: string) {
    this.retryStopped.delete(id);
    this.selected.delete(id);
    clearTimeout(this.refreshTimers.get(id));
    clearTimeout(this.liveTimers.get(id));
    this.refreshTimers.delete(id);
    this.liveTimers.delete(id);
    this.snapshots.delete(id);
    this.messages.delete(id);
    this.cache.delete(id);
    this.cursors.delete(id);
  }
  // Preview metadata never prepares media or expands the renderer timeline cache.
  async conversationIndex(id: string, cursor?: string) {
    await this.own(id);
    const page = await (
      await this.client()
    ).message.list({
      sessionID: id,
      limit: 150,
      ...(cursor ? { cursor } : { order: "desc" as const }),
    });
    return {
      items: page.data.flatMap((message) =>
        message.type === "user"
          ? [
              {
                id: message.id,
                text: this.engine.redactor.text(message.text).slice(0, 320),
                at: message.time.created,
              },
            ]
          : [],
      ),
      next: page.cursor.next,
    };
  }
  async transcript(id: string) {
    const info = await this.own(id),
      client = await this.client();
    const messages: SessionMessageInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.message.list({
        sessionID: id,
        limit: 150,
        ...(cursor ? { cursor } : { order: "asc" as const }),
      });
      messages.push(...page.data.map((message) => this.safeMessage(message)));
      cursor = page.cursor.next ?? undefined;
    } while (cursor);
    const content = messages
      .sort((a, b) => a.time.created - b.time.created)
      .flatMap((m) => {
        if (m.type !== "user" && m.type !== "assistant") return [];
        const text =
          m.type === "user"
            ? m.text
            : m.content
                .filter((p) => p.type === "text")
                .map((p) => p.text)
                .join("\n");
        return text
          ? [
              `## ${m.type === "user" ? "Пользователь" : "Ассистент"}\n\n${text}`,
            ]
          : [];
      });
    return this.engine.redactor.text(
      `# ${info.title ?? "Чат"}\n\n${content.join("\n\n")}\n`,
    );
  }
  async mode(id: string, mode: Mode) {
    const info = await this.own(id);
    if (info.metadata?.rcfReviewSource || info.metadata?.rcfReader)
      throw new Error("Разрешения ограниченной сессии нельзя расширить.");
    await (
      await this.client()
    ).session.update({
      sessionID: id,
      permissions: taskPermissions(
        workspaceOf(info),
        mode,
        info.metadata?.forgePlanning === true,
      ),
      metadata: { ...info.metadata, forgeMode: mode },
    });
    this.changed(id);
  }
  async search(input: {
    query: string;
    projectId?: string;
    workspace: Workspace;
  }): Promise<SearchResult[]> {
    this.searchController?.abort();
    const controller = new AbortController();
    this.searchController = controller;
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(12000),
    ]);
    const client = await this.client();
    const query = input.query.trim().slice(0, 200).toLocaleLowerCase();
    const directory = input.projectId
      ? this.storage.project(input.projectId).path
      : undefined;
    const sessions: SessionInfo[] = [];
    const results: SearchResult[] = [];
    const found = new Set<string>();
    try {
      let cursor: string | undefined;
      // Search is a bounded, lazy read of authorized history. It never builds
      // a second persistent index containing private messages or credentials.
      let visited = 0;
      do {
        const page = await client.session.list(
          {
            ...(cursor ? { cursor } : { directory, order: "desc" as const }),
            limit: 100,
          },
          { signal },
        );
        for (const info of page.data) {
          visited++;
          const project = this.projectFor(info);
          if (
            !project ||
            (input.projectId && project.id !== input.projectId) ||
            workspaceOf(info) !== input.workspace
          )
            continue;
          sessions.push(info);
          if (sessions.length >= 500) break;
        }
        cursor = page.cursor.next ?? undefined;
      } while (
        cursor &&
        sessions.length < 500 &&
        visited < 5000 &&
        !signal.aborted
      );
      for (const info of sessions) {
        const project = this.projectFor(info)!;
        const title = this.engine.redactor.text(info.title ?? "Новый чат");
        if (containsSecret(title)) continue;
        if (
          !query ||
          title.toLocaleLowerCase().includes(query) ||
          project.name.toLocaleLowerCase().includes(query)
        ) {
          results.push({
            sessionId: info.id,
            projectId: project.id,
            title,
            snippet: project.name,
          });
          found.add(info.id);
          if (results.length >= 80) return results;
        }
      }
      if (!query) return results;
      let inspected = 0;
      for (const info of sessions) {
        if (signal.aborted || inspected >= 6000 || results.length >= 80) break;
        if (found.has(info.id)) continue;
        const project = this.projectFor(info)!;
        let messageCursor: string | undefined;
        for (let pageIndex = 0; pageIndex < 2; pageIndex++) {
          const page = await client.message.list(
            {
              sessionID: info.id,
              limit: 150,
              ...(messageCursor
                ? { cursor: messageCursor }
                : { order: "desc" as const }),
            },
            { signal },
          );
          for (const message of page.data) {
            if (++inspected > 6000 || results.length >= 80) break;
            const text = this.engine.redactor.text(searchableMessage(message));
            if (
              !text ||
              containsSecret(text) ||
              !text.toLocaleLowerCase().includes(query)
            )
              continue;
            const title = this.engine.redactor.text(info.title ?? "Новый чат");
            if (containsSecret(title)) continue;
            results.push({
              sessionId: info.id,
              projectId: project.id,
              title,
              messageId: message.id,
              snippet: searchSnippet(text, query),
            });
            // One content result per chat makes navigation predictable and
            // leaves room for other projects in the compact result palette.
            found.add(info.id);
            break;
          }
          if (found.has(info.id) || inspected >= 6000 || results.length >= 80)
            break;
          messageCursor = page.cursor.next ?? undefined;
          if (!messageCursor) break;
        }
      }
      return results;
    } catch (error) {
      if (signal.aborted) return controller.signal.aborted ? [] : results;
      throw error;
    } finally {
      if (this.searchController === controller)
        this.searchController = undefined;
    }
  }
  private safeMessage(message: SessionMessageInfo): SessionMessageInfo {
    if (message.type !== "assistant") return message;
    return {
      ...message,
      content: message.content.map((part) =>
        part.type === "reasoning"
          ? {
              type: "reasoning" as const,
              text: "",
              ...(part.time ? { time: part.time } : {}),
            }
          : part,
      ),
    };
  }
  private async instructions(info: SessionInfo, client: OpenCodeClient) {
    const projectId = this.projectFor(info)!.id;
    const entries = this.storage.preferences().memoryEnabled
      ? this.storage.memoryList(projectId)
      : [];
    const context = memoryContext(entries);
    // A replaceable instruction entry avoids duplicating saved memory in every
    // user message. Disabling memory removes the entry before the next request.
    const key = "forge-user-context";
    const value = [
      workspaceOf(info) === "chat" ? CHAT_INSTRUCTIONS : "",
      info.metadata?.forgePlanning === true ? PLAN_INSTRUCTIONS : "",
      context,
    ]
      .filter(Boolean)
      .join("\n\n");
    if (value)
      await client.experimental.session.instructions.entry.put({
        sessionID: info.id,
        key,
        value,
      });
    else
      await client.experimental.session.instructions.entry.remove({
        sessionID: info.id,
        key,
      });
  }
  async send(
    id: string,
    text: string,
    model: ModelRef,
    mode: Mode,
    attachmentIds: string[],
    options?: PromptOptions,
  ) {
    const info = await this.own(id),
      client = await this.client();
    if (info.metadata?.rcfReviewSource || info.metadata?.rcfReader)
      throw new Error("Ограниченная сессия принимает только исходное задание.");
    if (
      workspaceOf(info) === "work" &&
      !(options?.planning ?? info.metadata?.forgePlanning === true)
    )
      await this.assertWritable(info.location.directory, id);
    const available = await this.models(this.projectFor(info)!.id);
    const selectedModel = available.find(
      (m) =>
        m.enabled && m.id === model.id && m.providerID === model.providerID,
    );
    if (!selectedModel)
      throw new Error(
        "Выбранная модель недоступна. Проверьте подключение провайдера.",
      );
    if (
      !selectedModel.image &&
      (await this.media.requiresImages(attachmentIds))
    )
      throw new Error(
        "Выбранная модель не поддерживает изображения. Выберите модель с поддержкой изображений для этих вложений.",
      );
    const files = await this.media.promptFiles(attachmentIds);
    const planning =
      workspaceOf(info) === "work" &&
      (options?.planning ?? info.metadata?.forgePlanning === true);
    if (
      planning !== (info.metadata?.forgePlanning === true) &&
      (await client.session.active())[id]
    )
      throw new Error(
        "Сначала остановите ответ агента, чтобы сменить режим планирования.",
      );
    const skillIds = [...new Set(options?.skills ?? [])];
    if (skillIds.length) {
      const availableSkills = await client.skill.list({
        location: info.location,
      });
      if (
        skillIds.some(
          (id) => !availableSkills.data.some((skill) => skill.id === id),
        )
      )
        throw new Error(
          "Выбранный навык недоступен в текущем проекте. Обновите список навыков.",
        );
    }
    // Operations within this method are serialized by Main IPC to avoid mode/model races.
    await client.session.update({
      sessionID: id,
      metadata: {
        ...info.metadata,
        forgeMode: mode,
        forgePlanning: planning,
        rcfCompleted: false,
      },
      permissions: taskPermissions(workspaceOf(info), mode, planning),
    });
    if (JSON.stringify(info.model) !== JSON.stringify(model))
      await client.session.switchModel({ sessionID: id, model });
    await this.instructions(
      { ...info, metadata: { ...info.metadata, forgePlanning: planning } },
      client,
    );
    this.retryStopped.delete(id);
    await client.session.prompt({
      sessionID: id,
      text,
      files,
      delivery: "queue",
      skills: skillIds.map((id) => ({ id })),
      metadata: { forgePlanning: planning },
    });
    this.changed(id);
  }
  async capabilities(projectId?: string): Promise<Capabilities> {
    const client = await this.client();
    const input = projectId
      ? { location: { directory: this.storage.project(projectId).path } }
      : {};
    const [skills, mcp, plugins] = await Promise.allSettled([
      client.skill.list(input),
      client.mcp.list(input),
      client.plugin.list(input),
    ]);
    return {
      skills:
        skills.status === "fulfilled"
          ? skills.value.data.map((s) => ({
              id: s.id,
              name: this.engine.redactor.text(s.name),
              description: this.engine.redactor.text(s.description ?? ""),
            }))
          : [],
      mcp:
        mcp.status === "fulfilled"
          ? mcp.value.data.map((s) => ({
              name: s.name,
              title: this.engine.redactor.text(s.title ?? s.name),
              status: s.status.status,
            }))
          : [],
      plugins:
        plugins.status === "fulfilled"
          ? plugins.value.data.map((p, i) => ({
              id: p.id ?? `plugin-${i + 1}`,
              status: p.state.status,
            }))
          : [],
      errors: [
        skills.status === "rejected" ? "skills" : "",
        mcp.status === "rejected" ? "mcp" : "",
        plugins.status === "rejected" ? "plugins" : "",
      ].filter(Boolean),
    };
  }
  async stop(id: string) {
    await this.own(id);
    const client = await this.client();
    const inbox = await client.session.inbox.list({ sessionID: id });
    for (const item of inbox)
      await client.session.inbox.cancel({ sessionID: id, inboxID: item.id });
    await client.session.interrupt({ sessionID: id, resume: false });
    this.changed(id);
  }
  async editLastMessage(
    id: string,
    messageId: string,
    text: string,
    model: ModelRef,
    mode: Mode,
  ): Promise<EditMessageResult> {
    const info = await this.own(id);
    const client = await this.client();
    const [active, inbox, page, available] = await Promise.all([
      client.session.active(),
      client.session.inbox.list({ sessionID: id }),
      client.message.list({ sessionID: id, limit: 150, order: "desc" }),
      this.models(this.projectFor(info)!.id),
    ]);
    if (active[id])
      throw new Error(
        "Сначала остановите ответ агента и дождитесь завершения остановки.",
      );
    if (inbox.length)
      throw new Error(
        "Сначала дождитесь обработки сообщений в очереди или удалите их из очереди.",
      );
    if (info.revert)
      throw new Error("В сессии уже есть незавершённый откат истории.");
    let last = page.data.find((message) => message.type === "user");
    let cursor = page.cursor.next;
    while (!last && cursor) {
      const older = await client.message.list({
        sessionID: id,
        cursor,
        limit: 150,
      });
      last = older.data.find((message) => message.type === "user");
      cursor = older.cursor.next;
    }
    if (!last || last.id !== messageId)
      throw new Error(
        "Можно изменить только последнее сообщение пользователя.",
      );
    if (
      !available.some(
        (m) =>
          m.enabled && m.id === model.id && m.providerID === model.providerID,
      )
    )
      throw new Error(
        "Выбранная модель недоступна. Проверьте подключение провайдера.",
      );
    if (
      last.files?.some((file) => file.mime.startsWith("image/")) &&
      !available.find(
        (item) => item.id === model.id && item.providerID === model.providerID,
      )?.image
    )
      throw new Error(
        "В последнем сообщении есть изображения. Выберите модель с поддержкой изображений перед повторной отправкой.",
      );
    const files = last.files?.map((file) => ({
      uri: `data:${file.mime};base64,${file.data}`,
      name: file.name,
      description: file.description,
      mention: file.mention,
    }));
    await this.mode(id, mode);
    if (JSON.stringify(info.model) !== JSON.stringify(model))
      await client.session.switchModel({ sessionID: id, model });
    await this.instructions(info, client);
    this.editing.add(id);
    let staged = false;
    let committed = false;
    try {
      await this.loading.get(id)?.catch(() => {});
      await client.session.revert.stage({
        sessionID: id,
        messageID: messageId,
        files: false,
      });
      staged = true;
      await client.session.revert.commit({ sessionID: id });
      committed = true;
      this.messages.delete(id);
      this.cursors.delete(id);
      this.snapshots.delete(id);
      this.live.clearSession(id);
      this.retryStopped.delete(id);
      await client.session.prompt({
        sessionID: id,
        text,
        files,
        agents: workspaceOf(info) === "chat" ? undefined : last.agents,
        skills: last.skills,
        metadata: last.metadata,
        delivery: "queue",
      });
      return { sent: true };
    } catch (error) {
      if (staged && !committed)
        await client.session.revert.clear({ sessionID: id }).catch(() => {});
      if (committed) {
        this.storage.saveDraft(id, text);
        return {
          sent: false,
          error: `История обновлена, но повторная отправка не удалась. Исправленный текст сохранён в черновике: ${this.engine.redactor.error(error)}`,
        };
      }
      throw error;
    } finally {
      this.editing.delete(id);
      this.changed(id);
    }
  }
  async models(projectId?: string): Promise<Model[]> {
    const data = await (
      await this.client()
    ).model.list({
      location: projectId
        ? { directory: this.storage.project(projectId).path }
        : undefined,
      types: ["chat"],
    });
    return data.data.map((m) => ({
      id: m.id,
      providerID: m.providerID,
      name: m.name,
      tools: m.capabilities.tools,
      image: m.capabilities.input.some((t) => /image/.test(t)),
      context: m.limit.context,
      enabled: m.enabled,
      variants: m.variants.map((v) => v.id),
    }));
  }
  async integrations(projectId?: string): Promise<Integration[]> {
    const data = await (
      await this.client()
    ).integration.list({
      location: projectId
        ? { directory: this.storage.project(projectId).path }
        : undefined,
    });
    const integrations: Integration[] = data.data.map((i) => ({
      id: i.id,
      name: i.name,
      connected: i.connections.length > 0,
      needsAuth:
        i.connections.length > 0 &&
        i.connections.every(
          (connection) => connection.status?.status === "needs_auth",
        ),
      methods: i.methods.map((m) => ({
        type: m.type,
        id: "id" in m ? m.id : undefined,
        label: "label" in m ? m.label : undefined,
        form: "form" in m ? m.form : undefined,
      })),
    }));
    const customProviders = await this.readProviderConfiguration().catch(
      () => undefined,
    );
    const byID = new Map(
      integrations.map((integration) => [integration.id, integration]),
    );
    for (const [id, provider] of Object.entries(
      customProviders?.providers ?? {},
    )) {
      if (
        !providerRuntimes.has(provider?.package ?? "") ||
        typeof provider?.settings?.baseURL !== "string"
      )
        continue;
      const name = typeof provider.name === "string" ? provider.name : id;
      const existing = byID.get(id);
      byID.set(id, {
        connected: false,
        methods: [],
        ...existing,
        id,
        name,
        custom: true,
      });
    }
    return [...byID.values()];
  }
  location(projectId?: string) {
    return projectId
      ? { directory: this.storage.project(projectId).path }
      : undefined;
  }
  changed(id?: string) {
    this.emit({ type: "changed", sessionId: id });
    if (
      id &&
      !this.editing.has(id) &&
      this.selected.has(id) &&
      !this.refreshTimers.has(id)
    )
      this.refreshTimers.set(
        id,
        setTimeout(() => {
          this.refreshTimers.delete(id);
          if (this.editing.has(id)) return;
          void this.snapshot(id).then(
            (snapshot) => {
              if (this.selected.has(id) && !this.editing.has(id))
                this.emit({ type: "snapshot", snapshot });
            },
            (error) =>
              this.selected.has(id) &&
              this.emit({
                type: "error",
                message: this.engine.redactor.error(error),
              }),
          );
        }, 120),
      );
  }
  private emitLive(id: string) {
    if (
      !this.selected.has(id) ||
      this.liveTimers.has(id) ||
      this.editing.has(id)
    )
      return;
    this.liveTimers.set(
      id,
      setTimeout(() => {
        this.liveTimers.delete(id);
        if (!this.selected.has(id) || this.editing.has(id)) return;
        const snapshot = this.snapshots.get(id),
          info = this.cache.get(id);
        if (!snapshot || !info) return;
        const messages = this.live.merge(id, this.messages.get(id) ?? []);
        this.emit({
          type: "snapshot",
          snapshot: {
            ...snapshot,
            rows: normalizeTimeline(
              messages,
              (uri) => this.media.resolve(info.location.directory, uri),
              (text) => this.engine.redactor.text(text),
              snapshot.session.running,
              info.location.directory,
            ),
          },
        });
      }, 32),
    );
  }
  private async listen() {
    let backoff = 500;
    while (!this.stopped) {
      this.controller = new AbortController();
      try {
        const client = await this.client();
        for await (const event of client.event.subscribe({
          signal: this.controller.signal,
        })) {
          if (this.stopped) break;
          if ("id" in event && event.id) {
            if (this.seen.has(event.id)) continue;
            this.seen.add(event.id);
            if (this.seen.size > 10000)
              this.seen.delete(this.seen.values().next().value!);
          }
          if (event.type === "server.connected") {
            this.live.clear();
            backoff = 500;
            this.engine.setStatus({ state: "ready" });
            // Subscriptions have no replay. Authoritative API hydration is mandatory.
            for (const id of this.selected) this.changed(id);
            this.emit({ type: "changed" });
          } else if (
            "data" in event &&
            event.data &&
            "sessionID" in event.data &&
            typeof event.data.sessionID === "string"
          ) {
            if (event.type === "session.execution.started")
              this.retryStopped.delete(event.data.sessionID);
            // OpenCode numbers the initial request as attempt 1. Attempts
            // 2–4 are the three allowed retries; stop before attempt 5 runs.
            // Keep the engine's delay/Retry-After policy and never resubmit a
            // prompt, change model or cancel queued user messages here.
            if (
              event.type === "session.retry.scheduled" &&
              event.data.attempt > 4 &&
              !this.retryStopped.has(event.data.sessionID)
            ) {
              const info = await client.session.get({
                sessionID: event.data.sessionID,
              });
              if (this.projectFor(info)) {
                this.retryStopped.add(info.id);
                try {
                  await client.session.interrupt({
                    sessionID: info.id,
                    resume: false,
                  });
                  this.emit({
                    type: "error",
                    message:
                      "Автоматические повторы остановлены после 3 повторных попыток. История сохранена; можно сменить модель и продолжить.",
                  });
                } catch (error) {
                  this.retryStopped.delete(info.id);
                  this.emit({
                    type: "error",
                    message: `Не удалось остановить автоматические повторы: ${this.engine.redactor.error(error)}`,
                  });
                }
              }
            }
            const liveSession = this.live.apply(event);
            if (liveSession) this.emitLive(liveSession);
            if (
              !event.type.endsWith(".delta") &&
              event.type !== "session.tool.progress" &&
              !event.type.startsWith("session.reasoning.")
            )
              this.changed(event.data.sessionID);
          } else if (
            [
              "model.updated",
              "integration.updated",
              "provider.updated",
            ].includes(event.type)
          )
            this.emit({ type: "changed" });
        }
        if (!this.stopped) throw new Error("Поток событий OpenCode закрыт.");
      } catch (error) {
        if (this.stopped) return;
        this.engine.setStatus({
          state: "reconnecting",
          error: this.engine.redactor.error(error),
        });
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, backoff);
          this.controller?.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        if (this.stopped) return;
        try {
          await this.engine.client?.server.info({
            signal: AbortSignal.timeout(3000),
          });
        } catch {
          this.engine.client = undefined;
          await this.engine.ensure().catch(() => {});
        }
        backoff = Math.min(backoff * 2, 10000);
      }
    }
  }
  private async readProviderConfiguration(): Promise<{
    providers?: Record<
      string,
      {
        name?: unknown;
        package?: string;
        settings?: { baseURL?: unknown };
      }
    >;
  }> {
    const filename = path.join(
      this.engine.env.XDG_CONFIG_HOME,
      "opencode",
      "opencode.json",
    );
    return fs
      .readFile(filename, "utf8")
      .then(JSON.parse)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return {};
        throw error;
      });
  }
  async customProviderSettings(
    id: string,
  ): Promise<SavedProviderSettings | undefined> {
    const config = await this.readProviderConfiguration();
    const provider = config.providers?.[id];
    if (!provider) return undefined;
    const runtime = providerRuntimes.get(provider.package ?? "");
    if (!runtime || typeof provider.settings?.baseURL !== "string")
      throw new Error(
        "Сохранённое подключение имеет неизвестный формат. Проверьте его конфигурацию.",
      );
    const url = new URL(safeExternal(provider.settings.baseURL));
    if (url.search || url.hash)
      throw new Error(
        "Сохранённый API URL содержит параметры. Задайте URL и ключ отдельно.",
      );
    return {
      name: typeof provider.name === "string" ? provider.name : id,
      baseUrl: url.href.replace(/\/$/, ""),
      runtime,
    };
  }
  async customProvider(input: {
    id: string;
    name: string;
    baseUrl: string;
    model: string;
    key?: string;
    images: boolean;
    tools: boolean;
    runtime: "compatible" | "openai" | "anthropic" | "openrouter";
  }) {
    const filename = path.join(
      this.engine.env.XDG_CONFIG_HOME,
      "opencode",
      "opencode.json",
    );
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const config = await fs
      .readFile(filename, "utf8")
      .then(JSON.parse)
      .catch((e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return {};
        throw e;
      });
    config.providers ??= {};
    const packages = {
      compatible: "openai-compatible",
      openai: "openai",
      anthropic: "anthropic",
      openrouter: "openrouter",
    };
    config.providers[input.id] = {
      ...config.providers[input.id],
      name: input.name,
      package: `@opencode/ai/providers/${packages[input.runtime]}`,
      settings: {
        ...config.providers[input.id]?.settings,
        baseURL: input.baseUrl,
      },
      models: {
        ...config.providers[input.id]?.models,
        [input.model]: {
          name: input.model,
          capabilities: {
            tools: input.tools,
            input: input.images ? ["text", "image"] : ["text"],
            output: ["text"],
          },
        },
      },
    };
    // Keys are stored exclusively by OpenCode's credential API, never in our configuration.
    const temp = `${filename}.tmp`;
    await fs.writeFile(temp, JSON.stringify(config, null, 2), { mode: 0o600 });
    await fs.rename(temp, filename);
    await (await this.client()).location.reload();
    if (input.key) {
      this.engine.redactor.add(input.key);
      await (
        await this.client()
      ).credential.create({
        integrationID: input.id,
        value: { type: "key", key: input.key },
        activate: true,
      });
    }
    this.emit({ type: "changed" });
  }
}
