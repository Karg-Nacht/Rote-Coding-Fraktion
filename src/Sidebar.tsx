import { tr, useLanguage, trf } from "./i18n";
import { ProjectMenu } from "./ProjectMenu";
import { ChatMenu } from "./ChatMenu";
import { useEffect, useState, type MouseEvent } from "react";
import {
  Archive,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  Folder,
  FolderOpen,
  MessageSquare,
  MoreHorizontal,
  PanelLeft,
  Pin,
  Plus,
  Search,
  Settings2,
  SquarePen,
} from "lucide-react";
import type { Project, Session } from "../shared/types";
import {
  addProject,
  api,
  archiveSession,
  attempt,
  newSession,
  openSession,
  savePreferences,
  selectProject,
  toggleSessionPin,
  useApp,
} from "./store";
import { FloatingPanel, IconButton, Modal } from "./components";
import { WorkspaceSwitcher } from "./WorkspaceMenus";

const panelPosition = (event: MouseEvent<HTMLElement>, side = false) => {
  const target = side
    ? (event.currentTarget.closest(".project-row") ?? event.currentTarget)
    : event.currentTarget;
  const box = target.getBoundingClientRect();
  return {
    x: side ? box.right + 10 : box.left,
    y: side ? box.top : box.bottom + 5,
  };
};
type Menu =
  | { kind: "session"; id: string; x: number; y: number }
  | { kind: "project" | "project-context"; id: string; x: number; y: number }
  | { kind: "sidebar"; x: number; y: number };

export function Sidebar({
  onRename,
  onArchive,
}: {
  onRename: (session: Session) => void;
  onArchive: () => void;
}) {
  useLanguage();

  const state = useApp();
  const [menu, setMenu] = useState<Menu | null>(null);
  const [allProjects, setAllProjects] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Project>();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const sort = state.preferences.chatSort ?? "updated";
  const orderSessions = (a: Session, b: Session) =>
    sort === "title"
      ? a.title.localeCompare(b.title, state.preferences.language ?? "ru", {
          numeric: true,
        })
      : sort === "created"
        ? b.created - a.created
        : b.updated - a.updated;
  const sessions = state.sessions
    .filter(
      (s) =>
        !s.parentId &&
        (s.workspace ?? "work") === (state.preferences.workspace ?? "work"),
    )
    .sort(orderSessions);
  const recents = state.sessions
    .filter((s) => !s.parentId)
    .slice()
    .sort(orderSessions);
  const pinnedProjects = state.preferences.pinnedProjects ?? [];
  const projects = state.projects.filter(p => !p.managed).sort(
    (a, b) =>
      Number(pinnedProjects.includes(b.id)) -
        Number(pinnedProjects.includes(a.id)) ||
      (a.section ?? "").localeCompare(b.section ?? "", "ru"),
  );
  const selectedSession =
    menu?.kind === "session"
      ? state.sessions.find((s) => s.id === menu.id)
      : undefined;
  const selectedProject =
    menu?.kind === "project" || menu?.kind === "project-context"
      ? state.projects.find((p) => p.id === menu.id)
      : undefined;
  const current = state.snapshot?.session;
  const act = (task: () => Promise<unknown>) => {
    setMenu(null);
    void attempt(task);
  };
  useEffect(() => {
    if (!selectedSession) return;
    const shortcuts = (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      const key = event.key.toLowerCase();
      if (event.altKey && key === "r") {
        event.preventDefault();
        event.stopPropagation();
        setMenu(null);
        onRename(selectedSession);
      }
      if (event.altKey && key === "p") {
        event.preventDefault();
        event.stopPropagation();
        act(() => toggleSessionPin(selectedSession));
      }
      if (event.shiftKey && key === "u") {
        event.preventDefault();
        event.stopPropagation();
        act(() =>
          api.markSessionUnread(selectedSession.id, !selectedSession.unread),
        );
      }
      if (event.shiftKey && key === "a") {
        event.preventDefault();
        event.stopPropagation();
        act(() => archiveSession(selectedSession));
      }
    };
    document.addEventListener("keydown", shortcuts);
    return () => document.removeEventListener("keydown", shortcuts);
  }, [selectedSession, onRename]);
  async function collapse(project: Project, collapsed: boolean) {
    await api.collapseProject(project.id, collapsed);
    const latest = useApp.getState();
    latest.set({
      projects: latest.projects.map((p) =>
        p.id === project.id ? { ...p, collapsed } : p,
      ),
    });
  }
  async function pinProject(project: Project) {
    const pinned = useApp.getState().preferences.pinnedProjects ?? [];
    await savePreferences({
      pinnedProjects: pinned.includes(project.id)
        ? pinned.filter((id) => id !== project.id)
        : [...pinned, project.id],
    });
  }
  const openProject = async (project: Project) => {
    if (project.collapsed) await collapse(project, false);
    await selectProject(project);
  };
  const renderRow = (session: Session, recent = false) => (
    <div
      key={session.id}
      data-session-id={session.id}
      data-workspace={session.workspace ?? "work"}
      className={`session-row ${recent ? "recent-chat-row" : ""} ${session.id === current?.id ? "selected" : ""} ${session.unread ? "unread" : ""}`}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu({
          kind: "session",
          id: session.id,
          x: event.clientX,
          y: event.clientY,
        });
      }}
    >
      <button
        className="session-link"
        title={
          recent
            ? `${session.title}\n${state.projects.find((p) => p.id === session.projectId)?.name ?? ""} · ${session.workspace === "chat" ? "Chat Faction" : "Work Faction"}`
            : session.title
        }
        onClick={() => void openSession(session)}
      >
        <span className="session-title">{session.title}</span>
        {session.running ? (
          <span className="running-dot" aria-label={tr("Выполняется")} />
        ) : session.outcome === "failed" ? (
          <CircleAlert
            size={13}
            className="session-failed"
            aria-label={tr("Ошибка в задаче")}
          />
        ) : null}
      </button>
      <div className="session-actions">
        <IconButton
          label={session.pinned ? tr("Открепить чат") : tr("Закрепить чат")}
          active={session.pinned}
          onClick={() => void attempt(() => toggleSessionPin(session))}
        >
          <Pin size={13} />
        </IconButton>
        <IconButton
          label={tr("Архивировать чат")}
          onClick={() => void attempt(() => archiveSession(session))}
        >
          <Archive size={13} />
        </IconButton>
        <button
          className="icon-button"
          title={tr("Меню чата")}
          aria-label={tr("Меню чата")}
          data-menu-trigger
          onClick={(event) =>
            setMenu(
              menu?.kind === "session" && menu.id === session.id
                ? null
                : { kind: "session", id: session.id, ...panelPosition(event) },
            )
          }
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
    </div>
  );
  const sessionRow = (session: Session) => renderRow(session);

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <WorkspaceSwitcher />
        <div className="sidebar-header-actions">
          <button
            className="icon-button"
            aria-label={tr("Организация панели")}
            data-menu-trigger
            onClick={(event) =>
              setMenu(
                menu?.kind === "sidebar"
                  ? null
                  : { kind: "sidebar", ...panelPosition(event) },
              )
            }
          >
            <MoreHorizontal size={15} />
          </button>
          <IconButton
            label={tr("Поиск чатов и команд · Ctrl+K")}
            onClick={() => state.set({ search: true })}
          >
            <Search size={15} />
          </IconButton>
          <IconButton
            label={tr("Скрыть боковую панель")}
            onClick={() => state.set({ sidebar: false })}
          >
            <PanelLeft size={15} />
          </IconButton>
        </div>
      </div>
      <button
        className="new-chat"
        onClick={() => void attempt(newSession)}
        disabled={state.engine.state !== "ready"}
      >
        <SquarePen size={16} />
        {tr("Новый чат")}
        <kbd>Ctrl N</kbd>
      </button>
      <div className="sidebar-scroll">
        {[
          ...new Set(
            sessions.map((s) => s.section).filter((s): s is string => !!s),
          ),
        ].map((section) => (
          <section className="sidebar-section" key={section}>
            <div className="section-label">{section}</div>
            {sessions
              .filter((s) => s.section === section && !s.pinned)
              .map(sessionRow)}
          </section>
        ))}
        {sessions.some((s) => s.pinned) && (
          <section className="sidebar-section pinned-section">
            <div className="section-label">{tr("Закреплено")}</div>
            {sessions.filter((s) => s.pinned).map(sessionRow)}
          </section>
        )}
        {state.preferences.showProjects !== false && (
          <section className="sidebar-section projects-section">
            <div className="section-label">
              <span>{tr("Проекты")}</span>
              <IconButton
                label={tr("Добавить проект")}
                onClick={() => void attempt(addProject)}
              >
                <Plus size={15} />
              </IconButton>
            </div>
            {projects.map((project, index) => {
              const tasks = sessions.filter(
                (s) => s.projectId === project.id && !s.pinned && !s.section,
              );
              const isAll = allProjects.has(project.id);
              return (
                <div
                  className="project-group"
                  key={project.id}
                  data-project-id={project.id}
                >
                  {project.section &&
                    project.section !== projects[index - 1]?.section && (
                      <div className="section-label">{project.section}</div>
                    )}
                  <div
                    className={`project-row ${state.preferences.projectId === project.id ? "current-project" : ""}`}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setMenu({
                        kind: "project-context",
                        id: project.id,
                        x: event.clientX,
                        y: event.clientY,
                      });
                    }}
                  >
                    <button
                      className="project-toggle"
                      aria-label={`${project.collapsed ? tr("Развернуть") : tr("Свернуть")} ${project.name}`}
                      onClick={() =>
                        void attempt(() =>
                          collapse(project, !project.collapsed),
                        )
                      }
                    >
                      {project.collapsed ? (
                        <ChevronRight size={12} />
                      ) : (
                        <ChevronDown size={12} />
                      )}
                    </button>
                    <button
                      className="project-name"
                      title={project.path}
                      onClick={() => void attempt(() => openProject(project))}
                    >
                      {project.collapsed ? (
                        <Folder size={15} />
                      ) : (
                        <FolderOpen size={15} />
                      )}
                      <span>{project.name}</span>
                      {pinnedProjects.includes(project.id) && (
                        <Pin className="project-pin-marker" size={11} />
                      )}
                    </button>
                    <div className="project-actions">
                      <button
                        className="icon-button"
                        aria-label={trf`Сведения о проекте ${project.name}`}
                        title={tr("Сведения о проекте")}
                        data-menu-trigger
                        onClick={(event) =>
                          setMenu(
                            menu?.kind === "project" && menu.id === project.id
                              ? null
                              : {
                                  kind: "project",
                                  id: project.id,
                                  ...panelPosition(event, true),
                                },
                          )
                        }
                      >
                        <MoreHorizontal size={14} />
                      </button>
                      <IconButton
                        label={trf`Новый чат в ${project.name}`}
                        disabled={state.engine.state !== "ready"}
                        onClick={() =>
                          void attempt(async () => {
                            await openProject(project);
                            await newSession();
                          })
                        }
                      >
                        <SquarePen size={14} />
                      </IconButton>
                    </div>
                  </div>
                  {!project.collapsed && (
                    <div className="project-sessions">
                      {(isAll ? tasks : tasks.slice(0, 5)).map(sessionRow)}
                      {state.preferences.projectId === project.id &&
                        !tasks.length &&
                        !sessions.some((s) => s.projectId === project.id) && (
                          <span className="no-sessions">
                            {tr("Чатов пока нет")}
                          </span>
                        )}
                      {tasks.length > 5 && (
                        <button
                          className="sidebar-show-more"
                          onClick={() =>
                            setAllProjects((values) => {
                              const next = new Set(values);
                              if (isAll) next.delete(project.id);
                              else next.add(project.id);
                              return next;
                            })
                          }
                        >
                          {isAll
                            ? tr("Свернуть список")
                            : trf`Показать ещё · ${tasks.length - 5}`}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            <button
              className="sidebar-add"
              onClick={() => void attempt(addProject)}
            >
              <Plus size={15} />
              {tr("Добавить проект")}
            </button>
          </section>
        )}
        <section
          className="sidebar-section recents-section"
          aria-label={tr("Недавние чаты")}
        >
          <div className="section-label">
            <button
              className="section-title-button"
              data-menu-trigger
              onClick={(event) =>
                setMenu(
                  menu?.kind === "sidebar"
                    ? null
                    : { kind: "sidebar", ...panelPosition(event) },
                )
              }
            >
              {tr("Недавние чаты")}
              <ChevronDown size={12} />
            </button>
            <div className="section-actions">
              <button
                className="icon-button"
                data-menu-trigger
                aria-label={tr("Организация чатов")}
                title={tr("Организация чатов")}
                onClick={(event) =>
                  setMenu(
                    menu?.kind === "sidebar"
                      ? null
                      : { kind: "sidebar", ...panelPosition(event) },
                  )
                }
              >
                <MoreHorizontal size={15} />
              </button>
              <IconButton
                label={tr("Новый чат")}
                onClick={() => void attempt(newSession)}
                disabled={state.engine.state !== "ready"}
              >
                <SquarePen size={14} />
              </IconButton>
            </div>
          </div>
          {recents.map((session) => renderRow(session, true))}
          {!recents.length && (
            <p className="sidebar-empty">
              {tr("Здесь появятся ваши новые чаты")}
            </p>
          )}
        </section>
      </div>
      <div className="sidebar-footer">
        <button className="sidebar-archive" onClick={onArchive}>
          <Archive size={15} />
          {tr("Архив чатов")}
        </button>
        <button
          className="engine-indicator"
          onClick={() => state.set({ settings: true })}
        >
          <span className={`status-dot ${state.engine.state}`} />
          <span>
            {state.engine.state === "ready"
              ? `OpenCode ${state.engine.version}`
              : state.engine.state === "starting"
                ? tr("Запуск OpenCode…")
                : state.engine.state === "reconnecting"
                  ? tr("Восстановление связи…")
                  : tr("Движок недоступен")}
          </span>
          <ChevronRight size={12} />
        </button>
      </div>
      {menu && (
        <FloatingPanel
          key={`${menu.kind}:${"id" in menu ? menu.id : ""}`}
          position={menu}
          close={() => setMenu(null)}
          label={
            selectedProject
              ? menu.kind === "project-context"
                ? tr("Действия с проектом")
                : tr("Сведения о проекте")
              : selectedSession
                ? tr("Действия с чатом")
                : tr("Организация панели")
          }
          className={
            selectedProject && menu.kind !== "project-context"
              ? "project-info-panel"
              : menu.kind === "project-context"
                ? "project-context-menu"
                : "sidebar-menu"
          }
          role={
            selectedProject && menu.kind !== "project-context"
              ? "dialog"
              : "menu"
          }
        >
          {selectedSession ? (
            <ChatMenu
              session={selectedSession}
              close={() => setMenu(null)}
              rename={() => {
                setMenu(null);
                onRename(selectedSession);
              }}
            />
          ) : selectedProject && menu.kind === "project-context" ? (
            <ProjectMenu
              project={selectedProject}
              close={() => setMenu(null)}
              edit={() => {
                setMenu(null);
                setName(selectedProject.name);
                setEditing(selectedProject);
              }}
            />
          ) : selectedProject ? (
            <>
              <div className="project-info-title">
                <FolderOpen size={16} />
                <strong>{selectedProject.name}</strong>
                <IconButton
                  label={
                    pinnedProjects.includes(selectedProject.id)
                      ? tr("Открепить проект")
                      : tr("Закрепить проект")
                  }
                  active={pinnedProjects.includes(selectedProject.id)}
                  onClick={() =>
                    void attempt(() => pinProject(selectedProject))
                  }
                >
                  <Pin size={14} />
                </IconButton>
              </div>
              <div className="project-info-count">
                <MessageSquare size={14} />
                {tr("Чатов:")}{" "}
                {
                  sessions.filter((s) => s.projectId === selectedProject.id)
                    .length
                }
              </div>
              <div className="menu-divider" />
              <button
                className="project-info-path"
                title={selectedProject.path}
                onClick={() => act(() => api.revealProject(selectedProject.id))}
              >
                <Folder size={14} />
                <span>{selectedProject.path}</span>
                <ArrowUpRight size={14} />
              </button>
              <button
                onClick={() => act(() => api.copyText(selectedProject.path))}
              >
                <Copy size={14} />
                <span>{tr("Копировать путь")}</span>
              </button>
              <div className="menu-divider" />
              <button
                onClick={() => {
                  setMenu(null);
                  setName(selectedProject.name);
                  setEditing(selectedProject);
                }}
              >
                <Settings2 size={14} />
                <span>{tr("Редактировать проект")}</span>
              </button>
            </>
          ) : (
            <>
              <div className="menu-heading">{tr("Сортировка чатов")}</div>
              {(
                [
                  ["updated", tr("По последней активности")],
                  ["created", tr("По дате создания")],
                  ["title", tr("По названию")],
                ] as const
              ).map(([value, label]) => (
                <button
                  role="menuitemradio"
                  aria-checked={sort === value}
                  key={value}
                  onClick={() =>
                    act(() => savePreferences({ chatSort: value }))
                  }
                >
                  <span>{label}</span>
                  {sort === value && <Check size={14} />}
                </button>
              ))}
              <div className="menu-divider" />
              <div className="menu-heading">{tr("Боковая панель")}</div>
              <button
                role="menuitemcheckbox"
                aria-checked={state.preferences.showProjects !== false}
                onClick={() =>
                  act(() =>
                    savePreferences({
                      showProjects: state.preferences.showProjects === false,
                    }),
                  )
                }
              >
                <Folder size={15} />
                <span>{tr("Показывать проекты")}</span>
                {state.preferences.showProjects !== false && (
                  <Check size={14} />
                )}
              </button>
              <button
                role="menuitem"
                onClick={() =>
                  act(async () => {
                    for (const project of useApp.getState().projects)
                      await collapse(project, true);
                  })
                }
              >
                <ChevronRight size={15} />
                <span>{tr("Свернуть все проекты")}</span>
              </button>
              <button
                role="menuitem"
                onClick={() =>
                  act(async () => {
                    for (const project of useApp.getState().projects)
                      await collapse(project, false);
                  })
                }
              >
                <ChevronDown size={15} />
                <span>{tr("Развернуть все проекты")}</span>
              </button>
            </>
          )}
        </FloatingPanel>
      )}
      {editing && (
        <Modal
          title={tr("Редактировать проект")}
          close={() => {
            if (!saving) setEditing(undefined);
          }}
        >
          <form
            className="dialog-body project-edit-form"
            onSubmit={(event) => {
              event.preventDefault();
              setSaving(true);
              void attempt(async () => {
                const project = await api.renameProject(
                  editing.id,
                  name.trim(),
                );
                const latest = useApp.getState();
                latest.set({
                  projects: latest.projects.map((p) =>
                    p.id === project.id ? project : p,
                  ),
                });
                setEditing(undefined);
              }).finally(() => setSaving(false));
            }}
          >
            <label>
              {tr("Название проекта")}
              <input
                autoFocus
                value={name}
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
                disabled={saving}
              />
            </label>
            <label>
              {tr("Папка проекта")}
              <span className="project-edit-path">{editing.path}</span>
            </label>
            <div className="dialog-actions">
              <button
                type="button"
                className="secondary"
                disabled={saving}
                onClick={() => setEditing(undefined)}
              >
                {tr("Отмена")}
              </button>
              <button className="primary" disabled={saving || !name.trim()}>
                {saving ? tr("Сохранение…") : tr("Сохранить")}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </aside>
  );
}
