import { tr, useLanguage } from "./i18n";
import { useEffect, useState } from "react";
import {
  Archive,
  ArrowLeft,
  Check,
  ChevronRight,
  Copy,
  Eye,
  Folder,
  GitFork,
  List,
  Pin,
  Share,
  SquarePen,
  Trash2,
  AppWindow,
} from "lucide-react";
import type { ReactNode } from "react";
import type { Session } from "../shared/types";
import {
  api,
  archiveSession,
  attempt,
  openSession,
  refreshSessions,
  toggleSessionPin,
  useApp,
} from "./store";

export function ChatMenu({
  session,
  close,
  rename,
}: {
  session: Session;
  close: () => void;
  rename: () => void;
}) {
  useLanguage();

  const app = useApp();
  const state = { ...app, projects: app.projects.filter(p => !p.managed) };
  const [page, setPage] = useState<
    "project" | "section" | "fork" | "copy" | "share"
  >();
  const [section, setSection] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    document
      .querySelector<HTMLButtonElement>('[role="menu"] button:not(:disabled)')
      ?.focus();
  }, [page]);
  const sections = [
    ...new Set(
      state.sessions.map((s) => s.section).filter((s): s is string => !!s),
    ),
  ];
  const run = (task: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    void attempt(async () => {
      await task();
      await refreshSessions();
      close();
    }).finally(() => setBusy(false));
  };
  const item = (
    label: string,
    icon: ReactNode,
    action: () => void,
    extra?: ReactNode,
    disabled = false,
  ) => (
    <button
      key={label}
      role="menuitem"
      aria-label={label}
      disabled={busy || disabled}
      onClick={action}
      className={label === tr("Удалить навсегда") ? "danger-text" : undefined}
    >
      {icon}
      <span>{label}</span>
      {extra}
    </button>
  );
  const branch = (
    label: string,
    icon: ReactNode,
    target: NonNullable<typeof page>,
  ) => item(label, icon, () => setPage(target), <ChevronRight size={13} />);
  const chooseSection = (name: string) =>
    run(() => api.sectionSession(session.id, name));
  if (page)
    return (
      <>
        {item(tr("Назад"), <ArrowLeft size={14} />, () => setPage(undefined))}
        <div className="menu-divider" />
        {page === "project" && (
          <>
            <div className="menu-heading">{tr("Перенести чат в проект")}</div>
            {state.projects.map((p) =>
              item(
                p.name,
                <Folder size={14} />,
                () =>
                  run(async () => {
                    await api.moveSession(session.id, p.id);
                    if (state.snapshot?.session.id === session.id)
                      await openSession({ ...session, projectId: p.id });
                  }),
                session.projectId === p.id ? <Check size={14} /> : undefined,
                session.running || session.projectId === p.id,
              ),
            )}
          </>
        )}
        {page === "section" && (
          <>
            <div className="menu-heading">{tr("Раздел боковой панели")}</div>
            {item(
              tr("Без раздела"),
              <List size={14} />,
              () => chooseSection(""),
              !session.section && <Check size={14} />,
            )}
            {sections.map((name) =>
              item(
                name,
                <List size={14} />,
                () => chooseSection(name),
                session.section === name && <Check size={14} />,
              ),
            )}
            <form
              className="menu-section-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (section.trim()) chooseSection(section.trim());
              }}
            >
              <input
                aria-label={tr("Новый раздел")}
                placeholder={tr("Новый раздел…")}
                maxLength={80}
                value={section}
                onChange={(e) => setSection(e.target.value)}
                disabled={busy}
              />
              <button
                aria-label={tr("Создать раздел и переместить чат")}
                disabled={busy || !section.trim()}
              >
                <Check size={15} />
              </button>
            </form>
          </>
        )}
        {page === "fork" && (
          <>
            <div className="menu-heading">
              {tr("Ответвление с историей · проект")}
            </div>
            {state.projects.map((p) =>
              item(
                p.name,
                <GitFork size={14} />,
                () =>
                  run(async () => {
                    const fork = await api.forkSession(session.id, p.id);
                    await openSession(fork);
                  }),
                undefined,
                session.running,
              ),
            )}
            <p className="menu-note">
              {tr(
                "Новый независимый чат с текущей историей. Файлы и Git-ветка не копируются.",
              )}
            </p>
          </>
        )}
        {page === "copy" && (
          <>
            {item(tr("Название"), <Copy size={14} />, () =>
              run(() => api.copySession(session.id, "title")),
            )}
            {item(tr("ID чата"), <Copy size={14} />, () =>
              run(() => api.copySession(session.id, "id")),
            )}
            {item(tr("Переписку"), <Copy size={14} />, () =>
              run(() => api.copySession(session.id, "text")),
            )}
          </>
        )}
        {page === "share" && (
          <>
            <p className="menu-note">
              {tr(
                "Сохраните переписку в Markdown и передайте файл. Перед отправкой проверьте содержимое. Публичная ссылка не создаётся.",
              )}
            </p>
            {item(tr("Сохранить Markdown…"), <Share size={14} />, () =>
              run(() => api.shareSession(session.id)),
            )}
          </>
        )}
      </>
    );
  return (
    <>
      {item(
        tr("Переименовать"),
        <SquarePen size={15} />,
        rename,
        <kbd>Ctrl Alt R</kbd>,
      )}
      {item(
        session.pinned ? tr("Открепить") : tr("Закрепить"),
        <Pin size={15} />,
        () => run(() => toggleSessionPin(session)),
        <kbd>Ctrl Alt P</kbd>,
      )}
      {item(
        session.unread
          ? tr("Отметить прочитанным")
          : tr("Отметить непрочитанным"),
        <Eye size={15} />,
        () => run(() => api.markSessionUnread(session.id, !session.unread)),
        <kbd>Ctrl Shift U</kbd>,
      )}
      {branch(tr("Проект"), <Folder size={15} />, "project")}
      {branch(tr("Раздел"), <List size={15} />, "section")}
      <div className="menu-divider" />
      {branch(tr("Ответвить"), <GitFork size={15} />, "fork")}
      <div className="menu-divider" />
      {branch(tr("Поделиться"), <Share size={15} />, "share")}
      {branch(tr("Копировать"), <Copy size={15} />, "copy")}
      <div className="menu-divider" />
      {item(tr("Открыть в новом окне"), <AppWindow size={15} />, () =>
        run(() => api.openSessionWindow(session.id)),
      )}
      <div className="menu-divider" />
      {item(
        tr("Архивировать"),
        <Archive size={15} />,
        () => run(() => archiveSession(session)),
        <kbd>Ctrl Shift A</kbd>,
      )}
      {item(
        tr("Удалить навсегда"),
        <Trash2 size={15} />,
        () =>
          run(async () => {
            if (await api.deleteSession(session.id)) {
              const latest = useApp.getState();
              if (latest.snapshot?.session.id === session.id)
                latest.set({
                  snapshot: undefined,
                  preferences: { ...latest.preferences, sessionId: undefined },
                });
            }
          }),
        undefined,
        session.running,
      )}
    </>
  );
}
