import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Folder,
  FolderOpen,
  LoaderCircle,
  Monitor,
  Plus,
  Search,
  Settings2,
  X,
} from "lucide-react";
import { api, attempt, selectChatProject, useApp } from "./store";
import { tr, trf, useLanguage } from "./i18n";
import { ComposerSurface } from "./ComposerSurface";
import type { Project } from "../shared/types";
import "./composer-context.css";

export function ComposerContext({ disabled, children }: { disabled: boolean; children?: ReactNode }) {
  useLanguage();
  const { projects, preferences, snapshot } = useApp();
  const [open, setOpen] = useState<"environment" | "project">();
  const [view, setView] = useState<"root" | "environments" | "manage">("root");
  const [query, setQuery] = useState("");
  const [directory, setDirectory] = useState("");
  const [busy, setBusy] = useState(false);
  const environment = useRef<HTMLButtonElement>(null),
    projectAnchor = useRef<HTMLDivElement>(null);
  const project = projects.find(
    (p) => p.id === preferences.projectId && !p.managed,
  );
  const close = () => setOpen(undefined);
  const showProjects = () => {
    setQuery("");
    setOpen("project");
  };
  useEffect(() => {
    const event = () => {
      if (!disabled) showProjects();
    };
    const shortcut = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        e.altKey &&
        e.shiftKey &&
        e.code === "KeyO" &&
        !document.querySelector(".modal-backdrop")
      ) {
        e.preventDefault();
        event();
      }
    };
    window.addEventListener("forge:project-picker", event);
    window.addEventListener("keydown", shortcut);
    return () => {
      window.removeEventListener("forge:project-picker", event);
      window.removeEventListener("keydown", shortcut);
    };
  }, [disabled]);
  useEffect(() => {
    if (open === "environment")
      void api
        .localEnvironment()
        .then((value) => setDirectory(value.directory))
        .catch(() => {});
  }, [open]);
  async function choose(project?: Project) {
    if (busy) return;
    const current = projects.find(
      (p) => p.id === preferences.projectId && !p.managed,
    );
    if (current?.id === project?.id) {
      close();
      return;
    }
    setBusy(true);
    await attempt(async () => {
      await selectChatProject(project);
      close();
    });
    setBusy(false);
  }
  async function browse() {
    setBusy(true);
    await attempt(async () => {
      const project = await api.addProject();
      if (!project) return;
      const bootstrap = await api.bootstrap();
      useApp.getState().set({ projects: bootstrap.projects });
      await selectChatProject(project);
      close();
    });
    setBusy(false);
  }
  return (
    <div className="composer-context-bar">
      <button
        ref={environment}
        className={`context-chip environment-chip ${open === "environment" ? "active" : ""}`}
        aria-label={tr("Среда выполнения")}
        aria-expanded={open === "environment"}
        aria-haspopup="dialog"
        onClick={() => {
          setOpen(open === "environment" ? undefined : "environment");
          setView("root");
          setQuery("");
        }}
      >
        <Monitor size={13} />
        <span>{tr("Этот компьютер")}</span>
        <ChevronDown size={10} />
      </button>
      <div
        className={`project-context-chip ${project ? "attached" : ""}`}
        ref={projectAnchor}
      >
        <button
          className="context-chip"
          title={tr("Изменить проект чата · Ctrl+Alt+Shift+O")}
          aria-label={
            project ? trf`Проект чата: ${project.name}` : tr("Выбрать проект")
          }
          aria-expanded={open === "project"}
          disabled={disabled || busy}
          onClick={() => (open === "project" ? close() : showProjects())}
        >
          {busy ? (
            <LoaderCircle className="spin" size={13} />
          ) : (
            <Folder size={13} />
          )}
          <span>{project?.name ?? tr("Выбрать проект")}</span>
        </button>
        {project && (
          <button
            className="context-detach"
            disabled={disabled || busy}
            title={tr("Работать без проекта")}
            aria-label={tr("Открепить проект от чата")}
            onClick={() => void choose()}
          >
            <X size={11} />
          </button>
        )}
      </div>
      {children}
      <ComposerSurface
        open={open === "environment"}
        anchor={environment}
        close={close}
        label={tr("Выбор среды выполнения")}
        className="environment-panel"
      >
        <div
          onKeyDown={(event) => {
            if (event.key === "Escape" && view !== "root") {
              event.preventDefault();
              event.stopPropagation();
              setView("root");
            }
          }}
        >
          {view === "root" ? (
            <>
              <div className="surface-search">
                <Search size={13} />
                <input
                  data-autofocus
                  aria-label={tr("Поиск сред")}
                  placeholder={tr("Найти среду…")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              {(!query ||
                `${tr("Этот компьютер")} this computer local`
                  .toLocaleLowerCase()
                  .includes(query.toLocaleLowerCase())) && (
                <button
                  data-panel-item
                  className="surface-item"
                  onClick={close}
                >
                  <Monitor size={14} />
                  <span>{tr("Этот компьютер")}</span>
                  <Check size={13} />
                </button>
              )}
              {(!query ||
                `${tr("Окружения")} environment`
                  .toLocaleLowerCase()
                  .includes(query.toLocaleLowerCase())) && (
                <button
                  data-panel-item
                  className="surface-item"
                  onClick={() => setView("environments")}
                >
                  <Cloud size={14} />
                  <span>{tr("Окружения")}</span>
                  <ChevronRight size={13} />
                </button>
              )}
            </>
          ) : (
            <>
              <button className="surface-back" onClick={() => setView("root")}>
                <ChevronLeft size={13} />
                {tr("Среды выполнения")}
              </button>
              <div className="environment-card">
                <div className="environment-symbol">
                  <Monitor size={21} />
                </div>
                <strong>{tr("Локальное окружение")}</strong>
                <small>{tr("Этот компьютер · выбрано")}</small>
              </div>
              {view === "environments" ? (
                <>
                  <button
                    data-panel-item
                    className="surface-item"
                    onClick={() => setView("manage")}
                  >
                    <Settings2 size={14} />
                    <span>{tr("Управление окружениями")}</span>
                    <ChevronRight size={13} />
                  </button>
                  <p className="surface-hint">
                    {tr(
                      "Дополнительные окружения появятся в следующих обновлениях.",
                    )}
                  </p>
                </>
              ) : (
                <>
                  <div className="environment-directory">
                    <span>{tr("Папки локальных задач")}</span>
                    <code>{directory}</code>
                  </div>
                  <p className="surface-hint">
                    {tr(
                      "Чат без проекта получает собственную папку задачи. Другие проекты можно выбрать в соседнем меню.",
                    )}
                  </p>
                  <button
                    data-panel-item
                    className="surface-item"
                    onClick={() => void attempt(() => api.revealTasks())}
                  >
                    <FolderOpen size={14} />
                    <span>{tr("Открыть папку задач")}</span>
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </ComposerSurface>
      <ComposerSurface
        open={open === "project"}
        anchor={projectAnchor}
        close={close}
        label={tr("Проект для этого чата")}
        className="project-context-panel"
      >
        <div className="surface-search">
          <Search size={14} />
          <input
            data-autofocus
            aria-label={tr("Поиск проектов")}
            placeholder={tr("Найти проект…")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="surface-scroll">
          {!query && (
            <button
              data-panel-item
              className="surface-item"
              disabled={busy}
              onClick={() => void choose()}
            >
              <Monitor size={14} />
              <span>{tr("Без проекта")}</span>
              {!project && <Check size={13} />}
            </button>
          )}
          {projects
            .filter(
              (p) =>
                !p.managed &&
                `${p.name} ${p.path}`
                  .toLocaleLowerCase()
                  .includes(query.toLocaleLowerCase()),
            )
            .map((p) => (
              <button
                data-panel-item
                className="surface-item"
                key={p.id}
                disabled={busy}
                onClick={() => void choose(p)}
              >
                <Folder size={14} />
                <span>
                  <strong>{p.name}</strong>
                  <small>{p.path}</small>
                </span>
                {p.id === project?.id && <Check size={13} />}
              </button>
            ))}
        </div>
        <button
          data-panel-item
          className="surface-item surface-bottom-action"
          disabled={busy}
          onClick={() => void browse()}
        >
          <Plus size={14} />
          <span>{tr("Открыть другую папку…")}</span>
        </button>
        {snapshot && (
          <p className="surface-hint">
            {tr("История чата сохранится. Файлы остаются в прежней папке.")}
          </p>
        )}
      </ComposerSurface>
    </div>
  );
}
