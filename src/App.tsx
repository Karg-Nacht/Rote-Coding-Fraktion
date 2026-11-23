import { tr, useLanguage, trf } from "./i18n";
import { useCallback, useEffect, useState } from "react";
import { BrandIcon } from "./BrandIcon";
import { TitlebarBrand } from "./TitlebarBrand";
import {
  ArrowUpRight,
  Archive,
  CircleDot,
  Folder,
  GitBranch,
  Home,
  LoaderCircle,
  Maximize2,
  MessageSquare,
  Minus,
  PanelLeft,
  Pin,
  Search,
  Settings2,
  Sparkles,
  SquarePen,
  X,
  ExternalLink,
  MoreHorizontal,
} from "lucide-react";
import {
  api,
  attempt,
  initialize,
  newSession,
  openSession,
  refreshSessions,
  report,
  useApp,
  archiveSession,
  toggleSessionPin,
} from "./store";
import { FloatingPanel, IconButton, Modal } from "./components";
import { ChatGutters } from "./ChatGutters";
import { Timeline } from "./Timeline";
import { Composer } from "./Composer";
import { Sidebar } from "./Sidebar";
import { Settings } from "./Settings";
import { GlobalSearch } from "./GlobalSearch";
import { ArchiveDialog } from "./ArchiveDialog";
import { ApplicationMenu, WorkspaceSwitcher } from "./WorkspaceMenus";
import { GitPanel } from "./GitPanel";
import { TaskControl } from "./TaskControl";
import type { Session } from "../shared/types";

export function App() {
  useLanguage();

  const state = useApp();
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const [rename, setRename] = useState("");
  const [renaming, setRenaming] = useState<Session>();
  const [handoff, setHandoff] = useState<string>();
  const [handingOff, setHandingOff] = useState(false);
  const project = state.projects.find(
    (p) => p.id === state.preferences.projectId && !p.managed,
  );
  const current = state.snapshot?.session;
  const workspace = state.preferences.workspace ?? "work";
  useEffect(() => setMenu(undefined), [current?.id, state.settings]);
  const closeSettings = useCallback(
    () => useApp.getState().set({ settings: false }),
    [],
  );
  const closeSearch = useCallback(
    () => useApp.getState().set({ search: false }),
    [],
  );
  useEffect(() => {
    void initialize().catch(report);
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty(
      "--chat-font-size",
      `${state.preferences.chatFontSize ?? 14}px`,
    );
    root.style.setProperty(
      "--code-font-size",
      `${state.preferences.codeFontSize ?? 12}px`,
    );
    root.dataset.density = state.preferences.density ?? "comfortable";
    root.dataset.theme = state.preferences.theme ?? "dark";
    root.dataset.motion =
      state.preferences.animations === false ? "reduced" : "auto";
    root.style.setProperty(
      "--sidebar-width",
      `${state.preferences.sidebarWidth ?? 260}px`,
    );
  }, [
    state.preferences.chatFontSize,
    state.preferences.codeFontSize,
    state.preferences.density,
    state.preferences.animations,
    state.preferences.sidebarWidth,
    state.preferences.theme,
  ]);
  useEffect(() => {
    const handler = () => {
      setArchiveOpen(true);
    };
    window.addEventListener("forge:open-archive", handler);
    return () => window.removeEventListener("forge:open-archive", handler);
  }, []);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || (!event.ctrlKey && !event.metaKey)) return;
      if (document.querySelector('[role="dialog"]')) return;
      const key = event.key.toLowerCase();
      const session = useApp.getState().snapshot?.session;
      if (session && event.altKey && key === "r") {
        event.preventDefault();
        setRename(session.title);
        setRenaming(session);
      }
      if (session && event.altKey && key === "p") {
        event.preventDefault();
        void attempt(() => toggleSessionPin(session));
      }
      if (session && event.shiftKey && key === "u") {
        event.preventDefault();
        void attempt(() => api.markSessionUnread(session.id, !session.unread));
      }
      if (session && event.shiftKey && key === "a") {
        event.preventDefault();
        void attempt(() => archiveSession(session));
      }
      if (key === "n" && !event.altKey) {
        event.preventDefault();
        void attempt(newSession);
      }
      if (key === "k") {
        event.preventDefault();
        state.set({ search: !useApp.getState().search });
      }
      if (event.key === ",") {
        event.preventDefault();
        state.set({ settings: !useApp.getState().settings });
      }
      if (event.key === "b") {
        event.preventDefault();
        state.set({ sidebar: !useApp.getState().sidebar });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  return (
    <div className="app-shell">
      <div className="titlebar">
        <div className="compact-workspace-switcher">
          <WorkspaceSwitcher />
        </div>
        <TitlebarBrand />
        <div className="window-controls">
          <IconButton
            label={tr("Свернуть окно")}
            onClick={() => api.windowAction("minimize")}
          >
            <Minus size={15} />
          </IconButton>
          <IconButton
            label={tr("Развернуть окно")}
            onClick={() => api.windowAction("maximize")}
          >
            <Maximize2 size={13} />
          </IconButton>
          <IconButton
            className="close-window"
            label={tr("Закрыть окно")}
            onClick={() => api.windowAction("close")}
          >
            <X size={16} />
          </IconButton>
        </div>
      </div>
      <div className="workspace">
        <nav className="rail" aria-label={tr("Разделы")}>
          <IconButton
            label={tr("Рабочее пространство")}
            active={!state.git && !state.settings}
            onClick={() =>
              state.set({ git: false, settings: false, sidebar: true })
            }
          >
            <Home size={19} />
          </IconButton>
          <IconButton
            label={tr("Новая задача")}
            onClick={() => void attempt(newSession)}
            disabled={state.engine.state !== "ready"}
          >
            <SquarePen size={18} />
          </IconButton>
          <IconButton
            label={tr("Поиск чатов и команд · Ctrl+K")}
            onClick={() => state.set({ search: true })}
          >
            <Search size={18} />
          </IconButton>
          <div className="rail-divider" />
          <IconButton
            label={tr("Изменения Git")}
            active={state.git}
            onClick={() => state.set({ git: !state.git })}
            disabled={!project || workspace === "chat"}
          >
            <GitBranch size={18} />
          </IconButton>
          <div className="rail-spacer" />
          <IconButton
            label={tr("Настройки")}
            active={state.settings}
            onClick={() => state.set({ settings: true })}
          >
            <Settings2 size={19} />
          </IconButton>
          <ApplicationMenu
            onArchive={() => {
              setArchiveOpen(true);
            }}
          />
        </nav>
        {state.sidebar && !state.settings && (
          <Sidebar
            onRename={(session) => {
              setRename(session.title);
              setRenaming(session);
            }}
            onArchive={() => {
              setArchiveOpen(true);
            }}
          />
        )}
        <main className="main-area">
          {state.settings ? (
            <Settings close={closeSettings} />
          ) : (
            <>
              <header className="workspace-header">
                <div className="workspace-title">
                  {!state.sidebar && (
                    <IconButton
                      label={tr("Показать боковую панель")}
                      onClick={() => state.set({ sidebar: true })}
                    >
                      <PanelLeft size={16} />
                    </IconButton>
                  )}
                  <span>
                    {current?.title ??
                      project?.name ??
                      tr("Рабочее пространство")}
                  </span>
                  {current?.running && (
                    <LoaderCircle className="spin muted" size={14} />
                  )}
                </div>
                <div className="header-actions">
                  {current && workspace === "chat" && (
                    <button
                      className="handoff-button"
                      onClick={() => {
                        const rows = state.snapshot!.rows;
                        const goal = [...rows]
                          .reverse()
                          .find((row) => row.type === "user");
                        const answer = [...rows]
                          .reverse()
                          .find((row) => row.type === "text");
                        setHandoff(
                          trf`Цель:\n${goal && "text" in goal ? goal.text.slice(0, 4000) : current.title}\n\nСогласованный контекст (проверьте перед передачей):\n${answer && "text" in answer ? answer.text.slice(0, 12000) : tr("Укажите план, ограничения и файлы.")}`,
                        );
                      }}
                    >
                      <ArrowUpRight size={13} />
                      {tr("В Work Faction")}
                    </button>
                  )}
                  {(current || project) && (
                    <button
                      className="icon-button"
                      data-menu-trigger
                      aria-label={tr("Действия с задачей")}
                      title={tr("Действия с задачей")}
                      aria-expanded={!!menu}
                      aria-haspopup="menu"
                      onClick={(e) => {
                        const box = e.currentTarget.getBoundingClientRect();
                        setMenu(
                          menu
                            ? undefined
                            : { x: box.right - 230, y: box.bottom + 6 },
                        );
                      }}
                    >
                      <MoreHorizontal size={18} />
                    </button>
                  )}
                  {menu && (
                    <FloatingPanel
                      position={menu}
                      close={() => setMenu(undefined)}
                      label={tr("Действия с задачей")}
                      className="session-menu"
                    >
                      {project && (
                        <>
                          <button
                            onClick={() => {
                              setMenu(undefined);
                              void attempt(() => api.revealProject(project.id));
                            }}
                          >
                            <ExternalLink size={14} />
                            {tr("Открыть папку проекта")}
                          </button>
                          {workspace === "work" && (
                            <button
                              onClick={() => {
                                setMenu(undefined);
                                state.set({ git: !state.git });
                              }}
                            >
                              <GitBranch size={14} />
                              {tr("Изменения проекта")}
                            </button>
                          )}
                        </>
                      )}
                      {current && (
                        <>
                          <button
                            onClick={() => {
                              setMenu(undefined);
                              void attempt(() =>
                                api.openSessionWindow(current.id),
                              );
                            }}
                          >
                            <ArrowUpRight size={14} />
                            {tr("Открыть в отдельном окне")}
                          </button>
                          <button
                            onClick={() => {
                              setMenu(undefined);
                              void attempt(() => toggleSessionPin(current));
                            }}
                          >
                            <Pin size={14} />
                            {current.pinned ? tr("Открепить") : tr("Закрепить")}
                          </button>
                          <button
                            onClick={() => {
                              setMenu(undefined);
                              setRename(current.title);
                              setRenaming(current);
                            }}
                          >
                            <SquarePen size={14} />
                            {tr("Переименовать")}
                          </button>
                          <button
                            onClick={() => {
                              setMenu(undefined);
                              void attempt(() => archiveSession(current));
                            }}
                          >
                            <Archive size={14} />
                            {tr(" Архивировать")}
                          </button>
                        </>
                      )}
                    </FloatingPanel>
                  )}
                </div>
                {workspace === "work" &&
                  project &&
                  state.engine.state === "ready" &&
                  !current?.directoryMissing && (
                    <TaskControl
                      key={current?.id ?? project.id}
                      project={project}
                      session={current}
                    />
                  )}
              </header>
              {current?.directoryMissing && (
                <div className="engine-banner">
                  Workspace directory is unavailable · history only ·{" "}
                  {current.directory}
                </div>
              )}
              {state.engine.state !== "ready" && (
                <div
                  className={`engine-banner ${state.engine.state === "error" ? "error" : ""}`}
                >
                  <CircleDot size={14} />
                  <span>
                    {state.engine.error ??
                      tr("Подключаем локальный движок OpenCode…")}
                  </span>
                  {state.engine.state === "error" && (
                    <button
                      onClick={() => void attempt(() => api.retryEngine())}
                    >
                      {tr("Повторить")}
                    </button>
                  )}
                </div>
              )}
              {state.engine.state === "ready" && state.engine.compatibility?.canSend === false && (
                <div className="engine-banner">
                  <CircleDot size={14} />
                  <span>{tr("OpenCode работает в ограниченном режиме. Отправка сообщений недоступна.")}</span>
                  <button onClick={() => state.set({ settings: true, settingsSection: "about" })}>
                    {tr("Диагностика OpenCode")}
                  </button>
                </div>
              )}
              <div className="conversation">
                <ChatGutters />
                {state.loading ? (
                  <div className="loading-view">
                    <LoaderCircle size={20} className="spin" />
                    {tr("Загружаю историю…")}
                  </div>
                ) : current ? (
                  <Timeline snapshot={state.snapshot!} />
                ) : (
                  <div className="welcome">
                    <div className="welcome-content">
                      <div className="welcome-mark">
                        <BrandIcon alt={tr("Логотип Rote Coding Fraktion")} />
                      </div>
                      <h1>
                        {workspace === "chat"
                          ? [
                              tr("Что обсудим?"),
                              tr("Какая идея у вас сегодня?"),
                              tr("С чего начнём разговор?"),
                            ][state.draftVersion % 3]
                          : [
                              tr("Над чем будем работать?"),
                              tr("Что создадим дальше?"),
                              tr("Какую идею воплотим?"),
                            ][state.draftVersion % 3]}
                      </h1>
                      <p>
                        {project
                          ? workspace === "chat"
                            ? trf`Обсудите ${project.name} или прикрепите файлы для анализа.`
                            : trf`Поставьте задачу для ${project.name}.`
                          : tr(
                              "Начните с идеи. Проект можно выбрать в любой момент.",
                            )}
                      </p>
                      {project && (
                        <div className="welcome-project">
                          <button
                            onClick={() =>
                              void attempt(() => api.revealProject(project.id))
                            }
                          >
                            <Folder size={15} />
                            {project.name}
                            <ArrowUpRight size={14} />
                          </button>
                        </div>
                      )}
                      <div className="suggestions">
                        {(workspace === "chat"
                          ? [
                              {
                                icon: MessageSquare,
                                title: tr("Обсудить идею"),
                                text: tr("Помоги проработать идею: "),
                              },
                              {
                                icon: Search,
                                title: tr("Разобрать документ"),
                                text: tr(
                                  "Проанализируй прикреплённый документ. Отдели факты от предположений и укажи страницы источников.",
                                ),
                              },
                              {
                                icon: Sparkles,
                                title: tr("Подготовить план"),
                                text: tr(
                                  "Помоги составить план реализации. Уточни цель, ограничения и критерии готовности: ",
                                ),
                              },
                            ]
                          : [
                              {
                                icon: Search,
                                title: tr("Разобраться в проекте"),
                                text: tr(
                                  "Изучи структуру проекта, опиши архитектуру и команды запуска. Пока не изменяй файлы.",
                                ),
                              },
                              {
                                icon: GitBranch,
                                title: tr("Проверить изменения"),
                                text: tr(
                                  "Изучи текущий git diff и найди возможные ошибки. Подкрепи замечания кодом и проверками.",
                                ),
                              },
                              {
                                icon: Sparkles,
                                title: tr("Реализовать идею"),
                                text: tr(
                                  "Помоги реализовать следующую функцию: ",
                                ),
                              },
                            ]
                        ).map((s) => (
                          <button
                            key={s.title}
                            onClick={() =>
                              window.dispatchEvent(
                                new CustomEvent("forge:prompt", {
                                  detail: s.text,
                                }),
                              )
                            }
                          >
                            <s.icon size={17} />
                            <span>{s.title}</span>
                            <ArrowUpRight size={13} />
                          </button>
                        ))}
                      </div>
                      <div className="welcome-foot">
                        <span className="tiny-dot" />
                        {tr("Ваши проекты и история хранятся локально")}
                      </div>
                    </div>
                  </div>
                )}
                {state.bootstrapped &&
                  !current?.reviewSourceId &&
                  !current?.directoryMissing &&
                  current?.agent !== "rcf-reader" && (
                    <Composer
                      key={
                        state.preferences.sessionId ??
                        `draft:${workspace}:${state.draftVersion}`
                      }
                    />
                  )}
              </div>
            </>
          )}
        </main>
        {state.git && !state.settings && workspace === "work" && project && (
          <GitPanel
            project={project}
            session={current}
            close={() => state.set({ git: false })}
          />
        )}
      </div>
      {archiveOpen && <ArchiveDialog close={() => setArchiveOpen(false)} />}
      {state.search && <GlobalSearch close={closeSearch} />}
      {handoff !== undefined && (
        <Modal
          title={tr("Передать в Work Faction")}
          close={() => {
            if (!handingOff) setHandoff(undefined);
          }}
        >
          <form
            className="handoff-form dialog-body"
            onSubmit={(event) => {
              event.preventDefault();
              if (!handoff.trim() || handingOff) return;
              setHandingOff(true);
              void attempt(async () => {
                const session = await api.createSession(
                  current?.projectId ?? project?.id,
                  state.preferences.model,
                  "cautious",
                  "work",
                );
                await api.saveDraft(session.id, handoff.trim());
                await openSession(session);
                await refreshSessions();
                setHandoff(undefined);
              }).finally(() => setHandingOff(false));
            }}
          >
            <p>
              {tr(
                "Проверьте цель, план и ограничения. Будет создана задача с черновиком сообщения.",
              )}
            </p>
            <textarea
              aria-label={tr("Контекст для Work Faction")}
              value={handoff}
              onChange={(event) => setHandoff(event.target.value)}
              maxLength={20000}
              rows={14}
            />
            <button
              className="primary"
              disabled={handingOff || !handoff.trim()}
            >
              {handingOff
                ? tr("Создаём задачу…")
                : tr("Создать задачу с черновиком")}
            </button>
          </form>
        </Modal>
      )}
      {renaming && (
        <Modal
          title={tr("Название задачи")}
          close={() => setRenaming(undefined)}
        >
          <form
            className="dialog-body"
            onSubmit={(e) => {
              e.preventDefault();
              void attempt(async () => {
                await api.renameSession(renaming.id, rename.trim());
                setRenaming(undefined);
                const latest = useApp.getState();
                if (latest.snapshot?.session.id === renaming.id)
                  latest.set({
                    snapshot: {
                      ...latest.snapshot,
                      session: {
                        ...latest.snapshot.session,
                        title: rename.trim(),
                      },
                    },
                  });
                await refreshSessions();
              });
            }}
          >
            <input
              autoFocus
              value={rename}
              onChange={(e) => setRename(e.target.value)}
              maxLength={200}
            />
            <button className="primary" disabled={!rename.trim()}>
              {tr("Сохранить")}
            </button>
          </form>
        </Modal>
      )}
      {state.error && (
        <div className="error-toast" role="alert">
          <span>{tr(state.error)}</span>
          <IconButton
            label={tr("Закрыть уведомление")}
            onClick={() => state.set({ error: undefined })}
          >
            <X size={16} />
          </IconButton>
        </div>
      )}
    </div>
  );
}
