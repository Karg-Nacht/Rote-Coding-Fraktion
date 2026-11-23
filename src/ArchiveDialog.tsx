import { tr, useLanguage, trf } from "./i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  Check,
  LoaderCircle,
  MessageSquare,
  Search,
  X,
} from "lucide-react";
import type { Session } from "../shared/types";
import { api, refreshSessions, useApp } from "./store";
import { IconButton, Modal } from "./components";
import { HistoryProjectFilter } from "./HistoryProjectFilter";
import "./history-dialogs.css";

export function ArchiveDialog({ close }: { close: () => void }) {
  const language = useLanguage();
  const dateFormat = new Intl.DateTimeFormat(
    language === "en" ? "en-US" : "ru-RU",
    { day: "numeric", month: "short" },
  );

  const { projects, preferences } = useApp();
  const workspace = preferences.workspace ?? "work";
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [projectId, setProjectId] = useState("");
  const [restoring, setRestoring] = useState<string>();
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState(0);
  const sequence = useRef(0);
  const list = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true);
    setError("");
    try {
      const pages = await Promise.all(
        projects.map(async (project) => {
          const all: Session[] = [];
          let cursor: string | undefined;
          do {
            const page = await api.sessions(project.id, cursor, true);
            all.push(...page.sessions);
            cursor = page.next ?? undefined;
          } while (cursor);
          return all;
        }),
      );
      if (request === sequence.current)
        setSessions(
          pages
            .flat()
            .filter((s) => !s.parentId && (s.workspace ?? "work") === workspace)
            .sort((a, b) => b.updated - a.updated),
        );
    } catch (e) {
      if (request === sequence.current)
        setError(String(e instanceof Error ? e.message : e));
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }, [projects, workspace]);
  useEffect(() => {
    void load();
    return () => {
      sequence.current++;
    };
  }, [load]);
  const normalized = query.trim().toLocaleLowerCase();
  const filtered = sessions.filter(
    (s) =>
      (!projectId || s.projectId === projectId) &&
      `${s.title} ${projects.find((p) => p.id === s.projectId)?.name ?? ""}`
        .toLocaleLowerCase()
        .includes(normalized),
  );
  const current = Math.min(selected, Math.max(0, filtered.length - 1));
  useEffect(() => {
    list.current
      ?.querySelector(`[data-archive-index="${current}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [current]);
  async function restore(session: Session) {
    if (restoring) return;
    setRestoring(session.id);
    setError("");
    setNotice("");
    try {
      await api.archiveSession(session.id, false);
      setSessions((items) => items.filter((item) => item.id !== session.id));
      setNotice(trf`«${session.title}» возвращён в проект`);
      await refreshSessions();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setRestoring(undefined);
    }
  }
  const mark = (text: string) => {
    const at = text.toLocaleLowerCase().indexOf(normalized);
    return at < 0 || !normalized ? (
      text
    ) : (
      <>
        {text.slice(0, at)}
        <mark>{text.slice(at, at + normalized.length)}</mark>
        {text.slice(at + normalized.length)}
      </>
    );
  };
  return (
    <Modal
      title={tr("Архив чатов")}
      close={close}
      headerless
      backdropClassName="history-backdrop"
      className="history-dialog archive-dialog"
    >
      <div className="archive-heading">
        <div className="archive-heading-icon">
          <Archive size={18} />
        </div>
        <div>
          <h2>
            {tr("Архив чатов ")}
            <span className="archive-count">{sessions.length}</span>
          </h2>
          <p>{tr("История сохранена. К разговору можно вернуться.")}</p>
        </div>
        <IconButton label={tr("Закрыть архив")} onClick={close}>
          <X size={16} />
        </IconButton>
      </div>
      <div className="archive-search-line">
        <Search size={15} />
        <input
          data-autofocus
          autoFocus
          aria-label={tr("Поиск в архиве")}
          placeholder={tr("Найти чат в архиве…")}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setSelected(
                (current + (e.key === "ArrowDown" ? 1 : -1) + filtered.length) %
                  Math.max(1, filtered.length),
              );
            } else if (e.key === "Enter" && filtered[current]) {
              e.preventDefault();
              if (!e.repeat) void restore(filtered[current]);
            }
          }}
        />
        {query && (
          <IconButton
            label={tr("Очистить поиск в архиве")}
            onClick={() => {
              setQuery("");
              setSelected(0);
            }}
          >
            <X size={13} />
          </IconButton>
        )}
        <HistoryProjectFilter
          projects={projects}
          value={projectId}
          onChange={(id) => {
            setProjectId(id);
            setSelected(0);
          }}
        />
      </div>
      <div className="archive-scope">
        <span>{workspace === "chat" ? "Chat Faction" : "Work Faction"}</span>
        <span>
          {normalized || projectId
            ? trf`Найдено ${filtered.length}`
            : tr("Последние изменения")}
        </span>
      </div>
      <div
        className="archive-results"
        ref={list}
        aria-label={tr("Архивные диалоги")}
        aria-busy={loading}
      >
        {loading ? (
          <div className="history-empty">
            <LoaderCircle className="spin" size={23} />
            <h3>{tr("Загружаем архив")}</h3>
            <p>{tr("Собираем сохранённые диалоги.")}</p>
          </div>
        ) : filtered.length ? (
          filtered.map((session, index) => {
            const project = projects.find((p) => p.id === session.projectId),
              busy = restoring === session.id;
            return (
              <div
                key={session.id}
                data-archive-id={session.id}
                data-archive-index={index}
                className={`archive-chat-row ${current === index ? "selected" : ""}`}
                onMouseMove={() => setSelected(index)}
              >
                <MessageSquare size={16} className="archive-chat-icon" />
                <div className="archive-chat-copy">
                  <strong title={session.title}>{mark(session.title)}</strong>
                  <span>
                    <span className="archive-project-name">
                      {mark(
                        project?.managed
                          ? tr("Без проекта")
                          : (project?.name ?? tr("Проект недоступен")),
                      )}
                    </span>
                    <span className="archive-meta-dot">·</span>
                    <time
                      dateTime={new Date(session.updated).toISOString()}
                      title={new Date(session.updated).toLocaleString(
                        language === "en" ? "en-US" : "ru-RU",
                      )}
                    >
                      {dateFormat.format(session.updated)}
                    </time>
                  </span>
                </div>
                <button
                  className="archive-restore-button"
                  disabled={!!restoring}
                  aria-label={trf`Восстановить чат «${session.title}»`}
                  onFocus={() => setSelected(index)}
                  onClick={() => void restore(session)}
                >
                  {busy ? (
                    <LoaderCircle size={13} className="spin" />
                  ) : (
                    <ArchiveRestore size={13} />
                  )}
                  <span>{busy ? tr("Возвращаем…") : tr("Восстановить")}</span>
                </button>
              </div>
            );
          })
        ) : (
          <div className="history-empty">
            <Archive size={27} />
            <h3>
              {normalized || projectId
                ? tr("Ничего не найдено")
                : tr("Архив пока пуст")}
            </h3>
            <p>
              {normalized || projectId
                ? tr("Попробуйте другое название или выберите все проекты.")
                : tr(
                    "Здесь будут чаты, которые вы убрали с боковой панели. Их история останется с вами.",
                  )}
            </p>
            {(query || projectId) && (
              <button
                className="history-empty-action"
                onClick={() => {
                  setQuery("");
                  setProjectId("");
                }}
              >
                {tr("Сбросить поиск")}
              </button>
            )}
          </div>
        )}
      </div>
      {error && (
        <div className="history-inline-error" role="alert">
          {error}
          {!sessions.length && (
            <button onClick={() => void load()}>{tr("Повторить")}</button>
          )}
        </div>
      )}
      <div className="archive-footer">
        {notice ? (
          <span className="archive-notice" role="status">
            <Check size={12} />
            {notice}
          </span>
        ) : (
          <span>{tr("Восстановленный чат вернётся в свой проект.")}</span>
        )}
        <span>
          <kbd>Esc</kbd> {tr(" закрыть")}
        </span>
      </div>
    </Modal>
  );
}
