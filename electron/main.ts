import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  protocol,
  shell,
} from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { LocalStorage } from "./storage";
import { Redactor, safeExternal } from "./security";
import { OpenCodeSupervisor } from "./supervisor";
import { EngineManager } from "./engine-manager";
import { BASE_ENGINE_VERSION } from "./engine-compatibility";
import { SessionCoordinator } from "./coordinator";
import { MediaService } from "./media";
import { WorkspaceGitService } from "./git";
import { providerModels } from "./provider-catalog";
import { omniRouteBaseUrl } from "../shared/provider-url";
import { translate } from "../shared/i18n";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { folderContext } from "./folder-context";
import { WorktreeService } from "./worktrees";
import { AgentControlService } from "./agent-control";
import { safeFile } from "./security";
import { PRODUCT_NAME, LEGACY_PROFILE } from "../shared/branding";
import { taskPermissions } from "../shared/permissions";
import type { AppEvent, Mode } from "../shared/types";

const windows = new Set<BrowserWindow>();
const root = path.dirname(fileURLToPath(import.meta.url));
app.setName(PRODUCT_NAME);
app.setPath(
  "userData",
  process.env.RCF_DATA_DIR || process.env.FORGE_DATA_DIR
    ? path.resolve(process.env.RCF_DATA_DIR ?? process.env.FORGE_DATA_DIR!)
    : path.join(app.getPath("appData"), LEGACY_PROFILE),
);
protocol.registerSchemesAsPrivileged([
  {
    scheme: "forge-media",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
const singleton = app.requestSingleInstanceLock();
if (!singleton) app.quit();
let window: BrowserWindow | undefined;
let coordinator: SessionCoordinator | undefined;
let storage: LocalStorage | undefined;
const tr = (text: string) =>
  translate(text, storage?.preferences().language ?? "ru");
let closing = false;
let engineMaintenance = false;
let requests = 0;
const maintenanceExempt = new Set([
  "bootstrap", "engineUpdateInfo", "checkEngineUpdate", "installEngineUpdate",
  "switchEngineVersion", "rollbackEngineVersion", "retryEngine",
]);
let readyToQuit = false;
const redactor = new Redactor();
const media = new MediaService(
  path.join(app.getPath("userData"), "attachments"),
);
const git = new WorkspaceGitService();
const emit = (event: AppEvent) => {
  for (const target of windows)
    if (!target.isDestroyed()) target.webContents.send("forge:event", event);
};
const id = z.string().min(1).max(300);
const cursor = z.string().min(1).max(16384);
const str = z.string().max(200000);
const mode = z.enum(["cautious", "autonomous", "full"]);
const model = z.object({ id, providerID: id, variant: id.optional() });
const answer = z.record(
  z.string().max(200),
  z.union([
    z.string().max(100000),
    z.number().finite(),
    z.boolean(),
    z.array(z.string()),
  ]),
);
const queues = new Map<string, Promise<unknown>>();
async function serialize<T>(key: string, run: () => Promise<T>): Promise<T> {
  const before = queues.get(key) ?? Promise.resolve();
  const next = before.catch(() => {}).then(run);
  queues.set(key, next);
  try {
    return await next;
  } finally {
    if (queues.get(key) === next) queues.delete(key);
  }
}
function handle(
  name: string,
  schema: z.ZodType,
  run: (...args: any[]) => unknown,
) {
  ipcMain.handle(`forge:${name}`, async (event, ...args) => {
    if (
      ![...windows].some(
        (target) =>
          event.sender === target.webContents &&
          event.senderFrame === target.webContents.mainFrame,
      )
    )
      throw new Error("Недопустимый источник IPC.");
    try {
      const parsed = schema.parse(args) as unknown[];
      if (maintenanceExempt.has(name)) return await run(...parsed);
      if (engineMaintenance) throw new Error("Дождитесь завершения обслуживания OpenCode.");
      requests++;
      try {
        return await run(...parsed);
      } finally {
        requests--;
      }
    } catch (error) {
      throw new Error(redactor.error(error));
    }
  });
}
async function confirm(title: string, detail: string, button = "Продолжить") {
  if (!window) return false;
  return (
    (
      await dialog.showMessageBox(BrowserWindow.getFocusedWindow() ?? window, {
        type: "warning",
        title: tr(title),
        message: tr(title),
        detail: tr(detail),
        buttons: [tr("Отмена"), tr(button)],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
    ).response === 1
  );
}
const fullGranted = new Set<string>();
async function authorizeMode(
  sessionId: string,
  nextMode: Mode,
  existingSession = true,
) {
  const info = existingSession ? await coordinator?.own(sessionId) : undefined;
  if (info?.metadata?.rcfReviewSource || info?.metadata?.rcfReader)
    throw new Error("Разрешения ограниченной сессии нельзя расширить.");
  if (nextMode !== "full" || fullGranted.has(sessionId)) return;
  if (
    !(await confirm(
      "Включить Full Access?",
      "OpenCode сможет выполнять команды и изменять файлы с правами вашей учётной записи, в том числе за пределами проекта. Это не изолированная среда. Правила администратора OpenCode продолжают действовать.",
      "Включить Full Access",
    ))
  )
    throw new Error("Full Access не включён.");
  fullGranted.add(sessionId);
}

async function setup() {
  storage = new LocalStorage(app.getPath("userData"));
  const binary =
    process.env.FORGE_ENGINE_PATH ??
    (app.isPackaged
      ? path.join(process.resourcesPath, "engine", "opencode.exe")
      : path.resolve(
          root,
          "../node_modules/@opencode/cli/bin",
          process.platform === "win32" ? "opencode.exe" : "opencode",
        ));
  const supervisor = new OpenCodeSupervisor(
    path.join(app.getPath("userData"), "engine"),
    binary,
    redactor,
    (status) => { if (!engineMaintenance) emit({ type: "engine", status }); },
  );
  const manager = new EngineManager(
    path.join(app.getPath("userData"), "engine-manager"),
    { directory: supervisor.directory, binary, version: process.env.FORGE_ENGINE_PATH ? undefined : BASE_ENGINE_VERSION },
    !!process.env.FORGE_ENGINE_PATH,
    () => supervisor.status.version,
    (update) => emit({ type: "engine-update", update }),
  );
  await manager.load();
  supervisor.configure(manager.selection());
  const sessions = (coordinator = new SessionCoordinator(
    storage,
    supervisor,
    media,
    (event) => { if (!engineMaintenance) emit(event); },
  ));
  const db = storage;
  const lifecycle = { engine: supervisor, start: () => sessions.start(), stop: () => sessions.close() };
  async function maintain<T>(run: () => Promise<T>, idle = true) {
    if (closing || engineMaintenance || requests)
      throw new Error("Дождитесь завершения текущих операций RCF.");
    engineMaintenance = true;
    const status = supervisor.status;
    try {
      if (idle) await supervisor.assertIdle();
      return await run();
    } finally {
      engineMaintenance = false;
      if (status !== supervisor.status) emit({ type: "engine", status: supervisor.status });
    }
  }
  const client = () => supervisor.ensure();
  const worktrees = new WorktreeService(db, client, git);
  const agents = new AgentControlService(sessions, db, client, worktrees);
  handle("worktrees", z.tuple([id]), (projectId) => worktrees.list(projectId));
  handle(
    "createWorktree",
    z.tuple([id, z.string().min(1).max(110)]),
    (projectId, branch) =>
      serialize("rcf-workspaces", () => worktrees.create(projectId, branch)),
  );
  handle(
    "createWorktreeSession",
    z.tuple([id, str, model.optional()]),
    (projectId, directory, selected) =>
      serialize("rcf-workspaces", async () => {
        const target = await worktrees.select(projectId, directory);
        return sessions.create(
          projectId,
          selected,
          "cautious",
          "work",
          target.directory,
        );
      }),
  );
  handle("removeWorktree", z.tuple([id, str]), (projectId, directory) =>
    serialize("rcf-workspaces", async () => {
      const target = await worktrees.assertRemovable(projectId, directory);
      if (
        !(await confirm(
          "Удалить worktree?",
          `${target.directory}\nВетка ${target.branch} и история сессий сохранятся. Рабочая папка будет удалена.`,
          "Удалить",
        ))
      )
        return false;
      await worktrees.remove(projectId, directory);
      sessions.changed();
      return true;
    }),
  );
  handle("finishTask", z.tuple([id]), (sessionId) =>
    serialize(sessionId, async () => {
      const info = await agents.work(sessionId);
      if ((await (await client()).session.active())[sessionId])
        throw new Error("Сначала остановите задачу.");
      await (
        await client()
      ).session.update({
        sessionID: sessionId,
        metadata: { ...info.metadata, rcfCompleted: true },
      });
      sessions.changed(sessionId);
    }),
  );
  handle("agents", z.tuple([id]), (sessionId) => agents.definitions(sessionId));
  handle("agentRuns", z.tuple([id]), (sessionId) => agents.children(sessionId));
  handle(
    "launchAgent",
    z.tuple([
      id,
      id,
      z.string().trim().min(1).max(20000),
      model.optional(),
      str.optional(),
    ]),
    (sessionId, agent, task, selected, directory) =>
      serialize("rcf-execution", () =>
        agents.launch(sessionId, agent, task, selected, directory),
      ),
  );
  handle("startReview", z.tuple([id, model]), (sessionId, selected) =>
    serialize("rcf-execution", () => agents.startReview(sessionId, selected)),
  );
  handle("reviewReport", z.tuple([id]), (sessionId) =>
    agents.report(sessionId),
  );
  handle("fixReview", z.tuple([id]), (sessionId) =>
    serialize("rcf-execution", async () => {
      const report = await agents.report(sessionId);
      if (
        await confirm(
          "Исправить замечания?",
          `Замечания: ${report.issues?.length ?? 0}. Они будут отправлены в основную задачу; режим Cautious. Повторное ревью запускается вручную.`,
          "Передать агенту",
        )
      )
        await agents.fix(sessionId);
    }),
  );
  handle("checkpoints", z.tuple([id]), (sessionId) =>
    agents.checkpoints(sessionId),
  );
  handle("restoreCheckpoint", z.tuple([id, id]), (sessionId, messageId) =>
    serialize(sessionId, async () => {
      const points = await agents.checkpoints(sessionId);
      const point = points.find((p) => p.messageId === messageId);
      if (!point) throw new Error("Точка восстановления не найдена.");
      if (
        !(await confirm(
          "Откатить историю сессии?",
          `${point.title}\nВсе сообщения начиная с этой точки будут удалены из истории. Файлы, Git-коммиты и незакоммиченные изменения сохранятся.`,
          "Откатить историю",
        ))
      )
        return false;
      await agents.restoreHistory(sessionId, messageId);
      return true;
    }),
  );
  handle("taskGitStatus", z.tuple([id]), async (sessionId) =>
    git.status((await agents.work(sessionId)).location.directory),
  );
  handle("taskGitDiff", z.tuple([id, str]), async (sessionId, file) =>
    git.diff((await agents.work(sessionId)).location.directory, file),
  );
  handle("openTaskFile", z.tuple([id, str]), async (sessionId, file) => {
    const info = await agents.work(sessionId);
    const target = await safeFile(info.location.directory, file);
    // File associations may execute .cmd/.js/.exe instead of editing them.
    // Launch a known text editor with a literal argument, without a shell.
    await new Promise<void>((resolve, reject) => {
      const editor = spawn("notepad.exe", [target], {
        windowsHide: false,
        detached: true,
        stdio: "ignore",
      });
      editor.once("error", reject);
      editor.once("spawn", () => {
        editor.unref();
        resolve();
      });
    });
  });
  const tasksDirectory = path.join(app.getPath("userData"), "tasks");
  const localTask = async () => {
    const directory = path.join(tasksDirectory, randomUUID());
    await fs.mkdir(directory, { recursive: true });
    const project = db.addProject(directory);
    db.set(`project:${project.id}`, { managed: true });
    db.renameProject(project.id, "Local task");
    return db.project(project.id);
  };
  handle("localEnvironment", z.tuple([]), () => ({
    directory: tasksDirectory,
  }));
  handle("revealTasks", z.tuple([]), async () => {
    await fs.mkdir(tasksDirectory, { recursive: true });
    const error = await shell.openPath(tasksDirectory);
    if (error) throw new Error(error);
  });
  handle("capabilities", z.tuple([id.optional()]), (projectId) =>
    sessions.capabilities(projectId),
  );
  handle(
    "connectMcp",
    z.tuple([id, z.boolean(), id.optional()]),
    (name, connected, projectId) =>
      serialize(`mcp:${projectId ?? "global"}:${name}`, async () => {
        const location = projectId
          ? { directory: db.project(projectId).path }
          : undefined;
        const c = await client();
        const known = await c.mcp.list({ location });
        if (!known.data.some((s) => s.name === name))
          throw new Error("Сервер MCP недоступен. Обновите список.");
        if (connected)
          await c.experimental.mcp.connect({ server: name, location });
        else await c.experimental.mcp.disconnect({ server: name, location });
      }),
  );
  handle(
    "addMcp",
    z.tuple([
      z
        .object({
          name: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
          type: z.enum(["local", "remote"]),
          url: z.string().max(2000).optional(),
          command: z
            .array(z.string().min(1).max(3000))
            .min(1)
            .max(50)
            .optional(),
        })
        .strict(),
      id.optional(),
    ]),
    async (input, projectId) => {
      const location = projectId
        ? { directory: db.project(projectId).path }
        : undefined;
      const c = await client();
      if (
        (await c.mcp.list({ location })).data.some((s) => s.name === input.name)
      )
        throw new Error("Сервер MCP с таким именем уже существует.");
      if (input.type === "remote") {
        const url = new URL(input.url ?? "");
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password
        )
          throw new Error("Укажите HTTP или HTTPS URL без учётных данных.");
        await c.experimental.mcp.add({
          server: input.name,
          location,
          config: { type: "remote", url: url.href, disabled: true },
        });
      } else {
        if (!input.command?.length)
          throw new Error("Укажите команду запуска MCP.");
        await c.experimental.mcp.add({
          server: input.name,
          location,
          config: { type: "local", command: input.command, disabled: true },
        });
      }
    },
  );
  protocol.handle("forge-media", (request) =>
    media.response(new URL(request.url).hostname),
  );

  handle("bootstrap", z.tuple([]), () => ({
    projects: db.projects(),
    sessions: [],
    preferences: db.preferences(),
    engine: supervisor.status,
  }));
  handle("addProject", z.tuple([]), async () => {
    const result = await dialog.showOpenDialog(window!, {
      title: tr("Добавить локальный проект"),
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const directory = await fs.realpath(result.filePaths[0]);
    const project = db.addProject(directory);
    db.savePreferences({ projectId: project.id, sessionId: undefined });
    return project;
  });
  const projectChats = async (projectId: string) => {
    const project = db.project(projectId),
      c = await client();
    const active = await c.session.active();
    for (const sessionID of Object.keys(active)) {
      if (
        (await c.session.get({ sessionID })).location.directory === project.path
      )
        throw new Error("Сначала остановите выполняющиеся чаты проекта.");
    }
    const all = [];
    let next: string | undefined;
    do {
      const page = await sessions.list(projectId, next);
      all.push(...page.sessions);
      next = page.next ?? undefined;
    } while (next);
    if (all.some((chat) => chat.running))
      throw new Error("Сначала остановите выполняющиеся чаты проекта.");
    return all;
  };
  handle("removeProject", z.tuple([id]), (projectId) =>
    serialize(`project:${projectId}`, async () => {
      const chats = await projectChats(projectId);
      for (const chat of chats) sessions.forget(chat.id);
      db.removeProject(projectId);
      sessions.changed();
    }),
  );
  handle(
    "sectionProject",
    z.tuple([id, z.string().trim().max(80)]),
    (projectId, section) => {
      const project = db.sectionProject(projectId, section);
      sessions.changed();
      return project;
    },
  );
  handle("archiveProjectChats", z.tuple([id]), (projectId) =>
    serialize(`project:${projectId}`, async () => {
      const chats = await projectChats(projectId),
        c = await client();
      for (const chat of chats)
        await c.session.update({ sessionID: chat.id, archived: true });
      sessions.changed();
    }),
  );
  handle(
    "collapseProject",
    z.tuple([id, z.boolean()]),
    (projectId, collapsed) => db.collapseProject(projectId, collapsed),
  );
  handle(
    "renameProject",
    z.tuple([id, z.string().trim().min(1).max(120)]),
    (projectId, name) => db.renameProject(projectId, name),
  );
  handle("copyText", z.tuple([z.string().max(16_000_000)]), (text) =>
    clipboard.writeText(text),
  );
  handle(
    "sessions",
    z.tuple([id, cursor.optional(), z.boolean().optional()]),
    (projectId, cursor, archived) => sessions.list(projectId, cursor, archived),
  );
  handle(
    "createSession",
    z.tuple([
      id.optional(),
      model.optional(),
      mode,
      z.enum(["work", "chat"]).optional(),
    ]),
    async (projectId, selected, selectedMode, workspace = "work") => {
      const project = projectId ? db.project(projectId) : await localTask();
      if (workspace === "work")
        await authorizeMode(project.id, selectedMode, false);
      return sessions.create(project.id, selected, selectedMode, workspace);
    },
  );
  handle(
    "conversationIndex",
    z.tuple([id, cursor.optional()]),
    (sessionId, cursor) => sessions.conversationIndex(sessionId, cursor),
  );
  handle("openSession", z.tuple([id]), (sessionId) => sessions.open(sessionId));
  handle("refreshSession", z.tuple([id]), (sessionId) =>
    sessions.snapshot(sessionId),
  );
  handle("olderMessages", z.tuple([id, cursor]), (sessionId, cursor) =>
    sessions.snapshot(sessionId, cursor),
  );
  handle(
    "renameSession",
    z.tuple([id, z.string().trim().min(1).max(200)]),
    async (sessionId, title) => {
      await sessions.own(sessionId);
      await (await client()).session.update({ sessionID: sessionId, title });
      sessions.changed(sessionId);
    },
  );
  handle(
    "pinSession",
    z.tuple([id, z.boolean()]),
    async (sessionId, pinned) => {
      await sessions.own(sessionId);
      db.pin(sessionId, pinned);
      sessions.changed(sessionId);
    },
  );
  handle(
    "archiveSession",
    z.tuple([id, z.boolean()]),
    async (sessionId, archived) => {
      await sessions.own(sessionId);
      await (await client()).session.update({ sessionID: sessionId, archived });
      sessions.changed(sessionId);
    },
  );
  const idleChat = async (sessionId: string) => {
    const info = await sessions.own(sessionId);
    if ((await (await client()).session.active())[sessionId])
      throw new Error("Сначала остановите выполняющийся чат.");
    return info;
  };
  handle(
    "changeSessionProject",
    z.tuple([id, id.optional()]),
    (sessionId, projectId) =>
      serialize(sessionId, async () => {
        const info = await idleChat(sessionId);
        if (info.metadata?.rcfReviewSource || info.metadata?.rcfReader)
          throw new Error("Рабочую папку ограниченной сессии менять нельзя.");
        if (
          (await (await client()).session.inbox.list({ sessionID: sessionId }))
            .length
        )
          throw new Error("Сначала дождитесь обработки сообщений в очереди.");
        const target = projectId ? db.project(projectId) : await localTask();
        const c = await client();
        await c.session.move({ sessionID: sessionId, directory: target.path });
        const mode =
          info.metadata?.forgeMode === "full"
            ? "full"
            : info.metadata?.forgeMode === "autonomous"
              ? "autonomous"
              : "cautious";
        await c.session.update({
          sessionID: sessionId,
          metadata: info.metadata,
          permissions: taskPermissions(
            info.metadata?.forgeWorkspace === "chat" ? "chat" : "work",
            mode,
            info.metadata?.forgePlanning === true,
          ),
        });
        sessions.changed(sessionId);
        return (await sessions.open(sessionId)).session;
      }),
  );
  handle(
    "markSessionUnread",
    z.tuple([id, z.boolean()]),
    async (sessionId, unread) => {
      await sessions.own(sessionId);
      db.setChatMeta(sessionId, { unread });
      sessions.changed();
    },
  );
  handle(
    "sectionSession",
    z.tuple([id, z.string().trim().max(80)]),
    async (sessionId, section) => {
      await sessions.own(sessionId);
      db.setChatMeta(sessionId, { section });
      sessions.changed();
    },
  );
  handle("moveSession", z.tuple([id, id]), (sessionId, projectId) =>
    serialize(sessionId, async () => {
      await idleChat(sessionId);
      await (
        await client()
      ).session.move({
        sessionID: sessionId,
        directory: db.project(projectId).path,
      });
      sessions.changed(sessionId);
    }),
  );
  handle("forkSession", z.tuple([id, id]), (sessionId, projectId) =>
    serialize(sessionId, async () => {
      const info = await idleChat(sessionId),
        project = db.project(projectId),
        c = await client();
      const fork = await c.session.fork({ sessionID: sessionId });
      if (fork.location.directory !== project.path)
        await c.session.move({ sessionID: fork.id, directory: project.path });
      await c.session.update({
        sessionID: fork.id,
        title: (info.title ?? "Чат") + " · ответвление",
        metadata: {
          ...info.metadata,
          ...fork.metadata,
          forgeWorkspace: info.metadata?.forgeWorkspace ?? "work",
          forgeSidebarFork: true,
        },
        ...(info.metadata?.forgeWorkspace === "chat"
          ? {
              permissions: [
                { action: "*", resource: "*", effect: "deny" as const },
              ],
            }
          : {}),
      });
      const result = (await sessions.snapshot(fork.id)).session;
      sessions.changed();
      return result;
    }),
  );
  handle(
    "copySession",
    z.tuple([id, z.enum(["title", "id", "text"])]),
    async (sessionId, kind) => {
      const info = await sessions.own(sessionId);
      clipboard.writeText(
        kind === "id"
          ? sessionId
          : kind === "title"
            ? (info.title ?? "Чат")
            : await sessions.transcript(sessionId),
      );
    },
  );
  handle("shareSession", z.tuple([id]), async (sessionId) => {
    const text = await sessions.transcript(sessionId);
    const result = await dialog.showSaveDialog(
      BrowserWindow.getFocusedWindow() ?? window!,
      {
        title: tr("Поделиться чатом — сохранить Markdown"),
        defaultPath: "RCF-chat.md",
        filters: [{ name: "Markdown", extensions: ["md"] }],
      },
    );
    if (result.canceled || !result.filePath) return false;
    await fs.writeFile(result.filePath, text, "utf8");
    return true;
  });
  handle("deleteSession", z.tuple([id]), (sessionId) =>
    serialize(sessionId, async () => {
      const info = await idleChat(sessionId);
      if (
        !(await confirm(
          "Удалить чат навсегда?",
          (info.title ?? tr("Чат")) +
            tr(
              ": история будет удалена без возможности восстановления. Файлы проекта останутся на месте.",
            ),
          "Удалить навсегда",
        ))
      )
        return false;
      await (await client()).session.remove({ sessionID: sessionId });
      sessions.forget(sessionId);
      db.forgetChat(sessionId);
      sessions.changed();
      return true;
    }),
  );
  handle("openSessionWindow", z.tuple([id]), async (sessionId) => {
    await sessions.own(sessionId);
    await createWindow(sessionId);
  });
  handle(
    "send",
    z.tuple([
      id,
      z.string().min(1).max(200000),
      model,
      mode,
      z.array(id).max(20),
      z
        .object({
          planning: z.boolean().optional(),
          skills: z.array(id).max(20).optional(),
        })
        .strict()
        .optional(),
    ]),
    (sessionId, text, selected, selectedMode, attachments, options) =>
      serialize("rcf-execution", () =>
        serialize(sessionId, async () => {
          if (
            (await sessions.own(sessionId)).metadata?.forgeWorkspace !==
              "chat" &&
            !options?.planning
          )
            await authorizeMode(sessionId, selectedMode);
          await sessions.send(
            sessionId,
            text,
            selected,
            selectedMode,
            attachments,
            options,
          );
        }),
      ),
  );
  handle("stop", z.tuple([id]), (sessionId) => sessions.stop(sessionId));
  handle(
    "editLastMessage",
    z.tuple([id, id, z.string().trim().min(1).max(200000), model, mode]),
    (sessionId, messageId, text, selected, selectedMode) =>
      serialize(sessionId, async () => {
        if ((await sessions.own(sessionId)).metadata?.forgeWorkspace !== "chat")
          await authorizeMode(sessionId, selectedMode);
        return sessions.editLastMessage(
          sessionId,
          messageId,
          text,
          selected,
          selectedMode,
        );
      }),
  );
  handle("setMode", z.tuple([id, mode]), (sessionId, selectedMode) =>
    serialize(sessionId, async () => {
      if ((await sessions.own(sessionId)).metadata?.forgeWorkspace !== "chat")
        await authorizeMode(sessionId, selectedMode);
      await sessions.mode(sessionId, selectedMode);
    }),
  );
  handle(
    "permission",
    z.tuple([id, id, z.enum(["once", "reject"])]),
    async (sessionId, requestID, decision) => {
      const info = await sessions.own(sessionId);
      if (
        (info.metadata?.rcfReviewSource || info.metadata?.rcfReader) &&
        decision !== "reject"
      )
        throw new Error(
          "Ограниченной сессии нельзя одобрить дополнительные инструменты.",
        );
      if (info.metadata?.forgeWorkspace === "chat" && decision !== "reject")
        throw new Error("Chat Faction не разрешает выполнение инструментов.");
      await (
        await client()
      ).permission.reply({ sessionID: sessionId, requestID, decision });
      sessions.changed(sessionId);
    },
  );
  handle(
    "replyForm",
    z.tuple([id, id, answer.nullable()]),
    async (sessionId, formID, fields) => {
      await sessions.own(sessionId);
      const api = (await client()).session.form;
      if (fields)
        await api.reply({ sessionID: sessionId, formID, answer: fields });
      else await api.cancel({ sessionID: sessionId, formID });
      sessions.changed(sessionId);
    },
  );
  handle("cancelQueued", z.tuple([id, id]), async (sessionId, inboxID) => {
    await sessions.own(sessionId);
    await (
      await client()
    ).session.inbox.cancel({ sessionID: sessionId, inboxID });
    sessions.changed(sessionId);
  });
  handle("models", z.tuple([id.optional()]), (projectId) =>
    sessions.models(projectId),
  );
  handle("integrations", z.tuple([id.optional()]), (projectId) =>
    sessions.integrations(projectId),
  );
  handle(
    "connectKey",
    z.tuple([id, z.string().min(1).max(10000), answer, id.optional()]),
    (integrationID, key, fields, projectId) =>
      serialize("providers", async () => {
        redactor.add(key);
        await (
          await client()
        ).integration.connect.key({
          integrationID,
          key,
          answer: fields,
          location: sessions.location(projectId),
        });
        sessions.changed();
      }),
  );
  handle(
    "connectExternal",
    z.tuple([id, id, answer, id.optional()]),
    async (integrationID, methodID, fields, projectId) => {
      await (
        await client()
      ).integration.connect.external({
        integrationID,
        methodID,
        answer: fields,
        location: sessions.location(projectId),
      });
      sessions.changed();
    },
  );
  handle(
    "oauthStart",
    z.tuple([id, id, answer, id.optional()]),
    async (integrationID, methodID, fields, projectId) =>
      (
        await (
          await client()
        ).integration.oauth.connect({
          integrationID,
          methodID,
          answer: fields,
          location: sessions.location(projectId),
        })
      ).data,
  );
  handle(
    "oauthComplete",
    z.tuple([id, id, str.optional(), id.optional()]),
    async (integrationID, attemptID, code, projectId) => {
      await (
        await client()
      ).integration.oauth.complete({
        integrationID,
        attemptID,
        code,
        location: sessions.location(projectId),
      });
      sessions.changed();
    },
  );
  handle(
    "oauthStatus",
    z.tuple([id, id, id.optional()]),
    async (integrationID, attemptID, projectId) =>
      (
        await (
          await client()
        ).integration.oauth.status({
          integrationID,
          attemptID,
          location: sessions.location(projectId),
        })
      ).data,
  );
  handle(
    "oauthCancel",
    z.tuple([id, id, id.optional()]),
    async (integrationID, attemptID, projectId) => {
      await (
        await client()
      ).integration.oauth.cancel({
        integrationID,
        attemptID,
        location: sessions.location(projectId),
      });
    },
  );
  handle(
    "customProvider",
    z.tuple([
      z.object({
        id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,80}$/),
        name: z.string().min(1).max(100),
        baseUrl: z
          .string()
          .url()
          .max(2000)
          .refine((v) => {
            try {
              safeExternal(v);
              return true;
            } catch {
              return false;
            }
          }),
        model: id,
        key: str.optional(),
        images: z.boolean(),
        tools: z.boolean(),
        runtime: z.enum(["compatible", "openai", "anthropic", "openrouter"]),
      }),
    ]),
    (input) => serialize("providers", () => sessions.customProvider(input)),
  );
  handle("customProviderSettings", z.tuple([id]), (providerId) =>
    sessions.customProviderSettings(providerId),
  );
  handle(
    "providerModels",
    z.tuple([
      z.object({
        baseUrl: z.string().url().max(2000),
        key: str.optional(),
        providerId: id.optional(),
      }),
    ]),
    async (input) => {
      let key = input.key?.trim();
      if (!key && input.providerId) {
        const saved = await sessions.customProviderSettings(input.providerId);
        if (saved) {
          if (
            omniRouteBaseUrl(saved.baseUrl) !== omniRouteBaseUrl(input.baseUrl)
          )
            throw new Error(
              "Для нового адреса введите API ключ явно. Сохранённый ключ используется только с сохранённым адресом сервера.",
            );
          const credential = (await (await client()).credential.list()).find(
            (entry) => entry.integrationID === input.providerId && entry.active,
          );
          if (credential?.value.type === "key") key = credential.value.key;
        }
      }
      if (key) redactor.add(key);
      return providerModels({ baseUrl: input.baseUrl, key });
    },
  );
  handle("attachments", z.tuple([]), async () => {
    const result = await dialog.showOpenDialog(window!, {
      title: tr("Прикрепить файлы"),
      properties: ["openFile", "multiSelections"],
    });
    return result.canceled ? [] : media.choose(result.filePaths);
  });
  handle("attachFolder", z.tuple([]), async () => {
    const result = await dialog.showOpenDialog(window!, {
      title: tr("Прикрепить структуру папки"),
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return [];
    return media.import([await folderContext(result.filePaths[0])]);
  });
  handle(
    "importAttachments",
    z.tuple([
      z
        .array(
          z
            .object({
              name: z.string().min(1).max(300),
              mime: z.string().max(200),
              bytes: z.union([
                z
                  .instanceof(Uint8Array)
                  .refine(
                    (bytes) =>
                      bytes.byteLength > 0 &&
                      bytes.byteLength <= 20 * 1024 * 1024,
                  ),
                z
                  .array(z.number().int().min(0).max(255))
                  .min(1)
                  .max(20 * 1024 * 1024),
              ]),
            })
            .strict(),
        )
        .min(1)
        .max(20),
    ]),
    (files) => media.import(files),
  );
  handle(
    "preparePdfAttachment",
    z.tuple([id, z.array(z.number().int().min(1)).min(1).max(6)]),
    (attachmentId, pages) => media.preparePdfAttachment(attachmentId, pages),
  );
  handle(
    "search",
    z.tuple([
      z
        .object({
          query: z.string().max(300),
          projectId: id.optional(),
          workspace: z.enum(["work", "chat"]),
        })
        .strict(),
    ]),
    (input) => sessions.search(input),
  );
  handle("listMemory", z.tuple([id.optional()]), (projectId) =>
    db.memoryList(projectId),
  );
  handle(
    "saveMemory",
    z.tuple([
      z
        .object({
          id: id.optional(),
          scope: z.enum(["global", "project"]),
          projectId: id.optional(),
          text: z.string().trim().min(1).max(2000),
        })
        .strict(),
    ]),
    (input) => {
      if (redactor.text(input.text) !== input.text)
        throw new Error("Секреты нельзя сохранять в памяти.");
      return db.memorySave(input);
    },
  );
  handle("deleteMemory", z.tuple([id]), (entryId) => db.memoryRemove(entryId));
  handle("sessionDiff", z.tuple([id]), async (sessionId) => {
    await sessions.own(sessionId);
    return (await (await client()).session.diff({ sessionID: sessionId })).map(
      (f) => ({ ...f, patch: redactor.text(f.patch) }),
    );
  });
  handle("gitStatus", z.tuple([id]), (projectId) =>
    git.status(db.project(projectId).path),
  );
  handle("gitDiff", z.tuple([id, id]), async (projectId, file) =>
    redactor.text(await git.diff(db.project(projectId).path, file)),
  );
  handle(
    "gitStage",
    z.tuple([id, z.array(id).min(1).max(1000), id.optional()]),
    async (projectId, files, sessionId) => {
      const info = sessionId ? await agents.work(sessionId) : undefined;
      if (info && sessions.describe(info).projectId !== projectId)
        throw new Error("Проект задачи не совпадает.");
      await git.stage(
        info?.location.directory ?? db.project(projectId).path,
        files,
      );
    },
  );
  handle(
    "gitAction",
    z.tuple([
      id,
      z.enum(["branch", "commit", "push", "pull", "pr"]),
      z.string().max(10000),
      str.optional(),
      id.optional(),
    ]),
    (projectId, action, value, body, sessionId) =>
      serialize(`git:${projectId}`, async () => {
        const info = sessionId ? await agents.work(sessionId) : undefined;
        if (info && sessions.describe(info).projectId !== projectId)
          throw new Error("Проект задачи не совпадает.");
        const directory =
          info?.location.directory ?? db.project(projectId).path;
        if (
          !(await confirm(
            `Git: ${action}`,
            `${directory}\n\n${tr(action === "commit" ? "Будут закоммичены только файлы, уже добавленные в индекс." : action === "pr" ? "Будет создан черновик Pull Request в GitHub." : "Операция будет выполнена в выбранном проекте.")}\n${value}`,
            "Выполнить",
          ))
        )
          throw new Error("Операция отменена.");
        return redactor.text(await git.action(directory, action, value, body));
      }),
  );
  handle("saveDraft", z.tuple([id, str]), (key, text) =>
    db.saveDraft(key, text),
  );
  handle("loadDraft", z.tuple([id]), (key) => db.draft(key));
  handle(
    "savePreferences",
    z.tuple([
      z
        .object({
          projectId: id.optional(),
          sessionId: id.optional(),
          model: model.optional(),
          mode: mode.optional(),
          sidebarWidth: z.number().min(210).max(400).optional(),
          favoriteModels: z
            .array(model.omit({ variant: true }))
            .max(500)
            .optional(),
          language: z.enum(["ru", "en"]).optional(),
          theme: z.enum(["dark", "light"]).optional(),
          showProjects: z.boolean().optional(),
          chatSort: z.enum(["updated", "created", "title"]).optional(),
          pinnedProjects: z.array(id).max(500).optional(),
          workspace: z.enum(["work", "chat"]).optional(),
          workspaceSessions: z
            .object({ work: id.optional(), chat: id.optional() })
            .strict()
            .optional(),
          chatFontSize: z.number().int().min(12).max(20).optional(),
          codeFontSize: z.number().int().min(11).max(18).optional(),
          density: z.enum(["comfortable", "compact"]).optional(),
          animations: z.boolean().optional(),
          uiScale: z.number().int().min(80).max(200).optional(),
          memoryEnabled: z.boolean().optional(),
          engineAutoCheck: z.boolean().optional(),
          engineNotify: z.boolean().optional(),
        })
        .strict(),
    ]),
    (preferences) => {
      db.savePreferences(preferences);
      if (preferences.uiScale !== undefined)
        for (const target of windows)
          target.webContents.setZoomFactor(preferences.uiScale / 100);
      if (preferences.theme !== undefined) {
        for (const target of windows) {
          target.setBackgroundColor(
            preferences.theme === "light" ? "#faf9f7" : "#101010",
          );
          target.setIcon(themeIcon(preferences.theme));
        }
        emit({ type: "theme", theme: preferences.theme });
      }
    },
  );
  handle("engineUpdateInfo", z.tuple([]), () => manager.info());
  handle("checkEngineUpdate", z.tuple([]), () => manager.check());
  handle("installEngineUpdate", z.tuple([]), async () => {
    const { available, latest, canInstall } = manager.info();
    if (!available || !canInstall || !latest) return manager.info();
    if (!(await confirm("Скачать обновление OpenCode?",
      "RCF проверит подпись и контрольную сумму пакета npm, затем запустит OpenCode с пустым тестовым профилем.",
      "Скачать и проверить"))) return manager.info();
    return maintain(async () => {
      if (manager.info().latest !== latest) throw new Error("Доступная версия изменилась. Проверьте обновления ещё раз.");
      return manager.stage();
    });
  });
  handle("switchEngineVersion", z.tuple([]), async () => {
    const staged = manager.info().staged;
    if (!staged || !(await confirm("Переключить версию OpenCode?",
      "Новая версия откроет копию данных OpenCode. Исходный профиль сохранится для возврата. В ограниченном режиме может быть доступно только чтение.",
      "Переключить"))) return manager.info();
    return maintain(async () => {
      if (manager.info().staged?.version !== staged.version) throw new Error("Подготовленная версия изменилась.");
      return manager.activate(lifecycle);
    });
  });
  handle("rollbackEngineVersion", z.tuple([]), async () => {
    const previous = manager.info().previous;
    if (!previous || !(await confirm("Вернуться к предыдущей версии OpenCode?",
      "Откроется сохранённый профиль этой версии. История и ключи, добавленные после переключения, останутся в более новом профиле. Проекты и настройки RCF сохранятся.",
      "Вернуться"))) return manager.info();
    return maintain(async () => {
      if (manager.info().previous !== previous) throw new Error("Предыдущая версия изменилась.");
      return manager.activate(lifecycle, true);
    });
  });
  handle("retryEngine", z.tuple([]), () => maintain(async () => {
    const active = await supervisor.client?.session.active().catch(() => ({}));
    if (
      active &&
      Object.keys(active).length &&
      !(await confirm(
        "Перезапустить OpenCode?",
        "Выполняющиеся задачи будут остановлены. История сохранится.",
        "Перезапустить",
      ))
    )
      return;
    await sessions.close();
    await sessions.start();
  }, false));
  handle("openExternal", z.tuple([z.string().max(10000)]), (url) =>
    shell.openExternal(safeExternal(url)),
  );
  handle("revealProject", z.tuple([id]), async (projectId) => {
    const error = await shell.openPath(db.project(projectId).path);
    if (error) throw new Error(`Не удалось открыть папку: ${error}`);
  });
  ipcMain.on("forge:window", (event, action) => {
    const target = [...windows].find(
      (w) =>
        w.webContents === event.sender &&
        event.senderFrame === w.webContents.mainFrame,
    );
    if (!target) return;
    if (action === "minimize") target.minimize();
    if (action === "maximize")
      target.isMaximized() ? target.unmaximize() : target.maximize();
    if (action === "close") target.close();
  });
  await createWindow();
  void sessions
    .start()
    .catch((error) => emit({ type: "error", message: redactor.error(error) }));
  const automaticCheck = () => {
    const update = manager.info();
    if (db.preferences().engineAutoCheck === false || engineMaintenance || closing ||
      (update.checkedAt && Date.now() - update.checkedAt < 6 * 60 * 60 * 1000)) return;
    void manager.check();
  };
  setTimeout(automaticCheck, 15000).unref();
  setInterval(automaticCheck, 30 * 60 * 1000).unref();
}
function themeIcon(theme?: string) {
  const name = theme === "light" ? "rcf-light.ico" : "rcf.ico";
  return app.isPackaged
    ? path.join(process.resourcesPath, name)
    : path.resolve(root, "../resources", name);
}

async function createWindow(sessionId?: string) {
  const target = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 780,
    minHeight: 560,
    backgroundColor:
      storage?.preferences().theme === "light" ? "#faf9f7" : "#101010",
    frame: false,
    title: "Rote Coding Fraktion",
    icon: themeIcon(storage?.preferences().theme),
    show: false,
    webPreferences: {
      preload: path.join(root, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  windows.add(target);
  target.webContents.setZoomFactor(
    (storage?.preferences().uiScale ?? 100) / 100,
  );
  if (!window || window.isDestroyed()) window = target;
  target.on("closed", () => {
    windows.delete(target);
    if (window === target) window = [...windows][0];
  });
  target.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  target.webContents.on("will-navigate", (event) => event.preventDefault());
  target.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  target.once("ready-to-show", () => target.show());
  target.on("close", (event) => {
    if (readyToQuit || windows.size > 1) return;
    event.preventDefault();
    if (closing || engineMaintenance) return;
    closing = true;
    void (async () => {
      const active = await coordinator?.engine.client?.session
        .active()
        .catch(() => ({}));
      if (
        active &&
        Object.keys(active).length &&
        !(await confirm(
          "Завершить приложение?",
          "Выполняющиеся задачи OpenCode будут остановлены. Их история сохранится.",
          "Остановить и выйти",
        ))
      ) {
        closing = false;
        return;
      }
      await coordinator?.close().catch(() => {});
      storage?.close();
      readyToQuit = true;
      app.quit();
    })();
  });
  if (process.env.FORGE_DEV_URL === "http://127.0.0.1:5183" && !app.isPackaged)
    await target.loadURL(
      process.env.FORGE_DEV_URL +
        (sessionId ? `?chat=${encodeURIComponent(sessionId)}` : ""),
    );
  else
    await target.loadFile(path.resolve(root, "../dist/index.html"), {
      query: sessionId ? { chat: sessionId } : {},
    });
}
app.on("second-instance", () => {
  if (window?.isMinimized()) window.restore();
  window?.focus();
});
if (singleton)
  void app
    .whenReady()
    .then(setup)
    .catch((error) => {
      dialog.showErrorBox(
        "Ошибка запуска Rote Coding Fraktion",
        redactor.error(error),
      );
      app.quit();
    });
app.on("window-all-closed", () => app.quit());
