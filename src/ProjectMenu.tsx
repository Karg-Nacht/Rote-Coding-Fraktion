import { tr, useLanguage } from "./i18n";
import { useEffect, useState } from "react";
import {
  Archive,
  ArrowLeft,
  Check,
  ChevronRight,
  FolderOpen,
  List,
  Pin,
  Settings2,
  X,
} from "lucide-react";
import type { Project } from "../shared/types";
import {
  api,
  attempt,
  refreshSessions,
  savePreferences,
  selectProject,
  useApp,
} from "./store";

export function ProjectMenu({
  project,
  close,
  edit,
}: {
  project: Project;
  close: () => void;
  edit: () => void;
}) {
  useLanguage();

  const state = useApp();
  const [sectionOpen, setSectionOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const pinned = state.preferences.pinnedProjects ?? [];
  const sections = [
    ...new Set(
      [
        ...state.projects.map((p) => p.section),
        ...state.sessions.map((s) => s.section),
      ].filter((name): name is string => !!name),
    ),
  ];
  useEffect(() => {
    document
      .querySelector<HTMLButtonElement>('[role="menu"] button:not(:disabled)')
      ?.focus();
  }, [sectionOpen]);
  const run = (task: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    void attempt(async () => {
      await task();
      close();
    }).finally(() => setBusy(false));
  };
  const setSection = (section: string) =>
    run(async () => {
      const updated = await api.sectionProject(project.id, section);
      const latest = useApp.getState();
      latest.set({
        projects: latest.projects.map((p) =>
          p.id === updated.id ? updated : p,
        ),
      });
    });
  if (sectionOpen)
    return (
      <>
        <button
          role="menuitem"
          onClick={() => setSectionOpen(false)}
          disabled={busy}
        >
          <ArrowLeft size={14} />
          <span>{tr("Назад")}</span>
        </button>
        <div className="menu-divider" />
        <button role="menuitem" disabled={busy} onClick={() => setSection("")}>
          <List size={14} />
          <span>{tr("Без раздела")}</span>
          {!project.section && <Check size={14} />}
        </button>
        {sections.map((section) => (
          <button
            role="menuitem"
            key={section}
            disabled={busy}
            onClick={() => setSection(section)}
          >
            <List size={14} />
            <span>{section}</span>
            {project.section === section && <Check size={14} />}
          </button>
        ))}
        <form
          className="menu-section-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) setSection(name.trim());
          }}
        >
          <input
            aria-label={tr("Новый раздел")}
            placeholder={tr("Новый раздел…")}
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
          <button
            aria-label={tr("Создать раздел для проекта")}
            disabled={busy || !name.trim()}
          >
            <Check size={15} />
          </button>
        </form>
      </>
    );
  return (
    <>
      <button
        role="menuitem"
        disabled={busy}
        onClick={() =>
          run(() =>
            savePreferences({
              pinnedProjects: pinned.includes(project.id)
                ? pinned.filter((id) => id !== project.id)
                : [...pinned, project.id],
            }),
          )
        }
      >
        <Pin size={15} />
        <span>
          {pinned.includes(project.id) ? tr("Открепить") : tr("Закрепить")}
        </span>
      </button>
      <button role="menuitem" disabled={busy} onClick={edit}>
        <Settings2 size={15} />
        <span>{tr("Редактировать")}</span>
      </button>
      <div className="menu-divider" />
      <button
        role="menuitem"
        aria-haspopup="menu"
        disabled={busy}
        onClick={() => setSectionOpen(true)}
      >
        <List size={15} />
        <span>{tr("Раздел")}</span>
        <ChevronRight size={13} />
      </button>
      <button
        role="menuitem"
        disabled={busy}
        onClick={() => run(() => api.revealProject(project.id))}
      >
        <FolderOpen size={15} />
        <span>{tr("Открыть в Проводнике")}</span>
      </button>
      <div className="menu-divider" />
      <button
        role="menuitem"
        disabled={busy}
        onClick={() =>
          run(async () => {
            await api.archiveProjectChats(project.id);
            const latest = useApp.getState();
            if (latest.snapshot?.session.projectId === project.id)
              await selectProject(project);
            await refreshSessions();
          })
        }
      >
        <Archive size={15} />
        <span>{tr("Архивировать чаты")}</span>
      </button>
      <div className="menu-divider" />
      <button
        role="menuitem"
        disabled={busy}
        onClick={() =>
          run(async () => {
            await api.removeProject(project.id);
            const latest = useApp.getState(),
              projects = latest.projects.filter((p) => p.id !== project.id);
            latest.set({
              projects,
              sessions: latest.sessions.filter(
                (s) => s.projectId !== project.id,
              ),
              preferences: {
                ...latest.preferences,
                pinnedProjects: (
                  latest.preferences.pinnedProjects ?? []
                ).filter((id) => id !== project.id),
              },
            });
            if (latest.preferences.projectId === project.id) {
              if (projects[0]) await selectProject(projects[0]);
              else
                latest.set({
                  snapshot: undefined,
                  preferences: {
                    ...useApp.getState().preferences,
                    projectId: undefined,
                    sessionId: undefined,
                  },
                });
            }
            await refreshSessions();
          })
        }
      >
        <X size={15} />
        <span>{tr("Убрать проект")}</span>
      </button>
    </>
  );
}
