import { tr, useLanguage } from "./i18n";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  Archive,
  ArrowLeft,
  ArrowUpRight,
  CornerDownLeft,
  FolderPlus,
  LoaderCircle,
  MessageSquare,
  Search,
  Settings2,
  SquarePen,
  X,
  type LucideIcon,
} from "lucide-react";
import type { SearchResult, Session, Workspace } from "../shared/types";
import { addProject, api, newSession, openSession, useApp } from "./store";
import { IconButton, Modal } from "./components";
import { HistoryProjectFilter } from "./HistoryProjectFilter";
import { categories, parameters } from "./settings-index";
import "./history-dialogs.css";

type Item = {
  id: string;
  label: string;
  icon: LucideIcon;
  meta?: string;
  shortcut?: string;
  result?: SearchResult;
  run: () => void | Promise<unknown>;
};

function recentChats(
  sessions: Session[],
  workspace: Workspace,
  projectId = "",
): SearchResult[] {
  return sessions
    .filter(
      (s) =>
        !s.parentId &&
        (s.workspace ?? "work") === workspace &&
        (!projectId || s.projectId === projectId),
    )
    .slice()
    .sort((a, b) => b.updated - a.updated)
    .slice(0, 9)
    .map((s) => ({
      sessionId: s.id,
      projectId: s.projectId,
      title: s.title,
      snippet: "",
    }));
}

export function GlobalSearch({ close }: { close: () => void }) {
  useLanguage();

  const { projects, preferences, sessions, engine } = useApp();
  const [query, setQuery] = useState("");
  const [projectId, setProjectId] = useState("");
  const [results, setResults] = useState<SearchResult[]>(() =>
    recentChats(sessions, preferences.workspace ?? "work"),
  );
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [settingsMode, setSettingsMode] = useState(false);
  const [settingsQuery, setSettingsQuery] = useState("");
  const [opening, setOpening] = useState(false);
  const choosing = useRef(false);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const workspace = preferences.workspace ?? "work";
  const normalized = query.trim().toLocaleLowerCase();
  useEffect(() => {
    let active = true;
    setSelected(0);
    setError("");
    if (settingsMode) {
      setLoading(false);
      return;
    }
    if (!normalized) {
      setResults(recentChats(sessions, workspace, projectId));
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      void api
        .search({ query, projectId: projectId || undefined, workspace })
        .then((items) => {
          if (active) setResults(items);
        })
        .catch((e) => {
          if (active) setError(String(e.message ?? e));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 180);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, projectId, workspace, sessions, settingsMode]);
  async function choose(result: SearchResult) {
    const session = sessions.find((s) => s.id === result.sessionId);
    if (session) await openSession(session);
    else {
      const snapshot = await api.openSession(result.sessionId),
        state = useApp.getState();
      state.set({
        snapshot,
        preferences: {
          ...state.preferences,
          projectId: result.projectId,
          sessionId: result.sessionId,
          workspace: snapshot.session.workspace ?? "work",
          model: snapshot.session.model ?? state.preferences.model,
          mode: snapshot.session.mode,
        },
      });
    }
    if (useApp.getState().snapshot?.session.id !== result.sessionId) return;
    useApp.getState().set({
      settings: false,
      searchTarget: result.messageId
        ? { sessionId: result.sessionId, messageId: result.messageId, query }
        : undefined,
    });
    close();
  }
  const openSettings = (section: string) => {
    useApp.getState().set({ settings: true, settingsSection: section });
    close();
  };
  const allActions: Item[] = [
    ...(engine.state === "ready"
      ? [
          {
            id: "new",
            label: tr("Новый чат"),
            icon: SquarePen,
            shortcut: "Ctrl N",
            run: async () => {
              await newSession();
              useApp.getState().set({ settings: false });
              close();
            },
          },
        ]
      : []),
    {
      id: "folder",
      label: tr("Открыть проект"),
      icon: FolderPlus,
      run: async () => {
        await addProject();
        useApp.getState().set({ settings: false });
        close();
      },
    },
    {
      id: "settings",
      label: tr("Настройки"),
      icon: Settings2,
      shortcut: "Ctrl ,",
      run: () => {
        setSettingsMode(true);
        setSettingsQuery("");
        setSelected(0);
        input.current?.focus();
      },
    },
    {
      id: "archive",
      label: tr("Архив чатов"),
      icon: Archive,
      run: () => {
        close();
        window.dispatchEvent(new CustomEvent("forge:open-archive"));
      },
    },
  ];
  const actions = allActions.filter(
    (item) =>
      !normalized ||
      `${item.label} ${item.id}`.toLocaleLowerCase().includes(normalized),
  );
  const chats: Item[] = results.map((r, i) => ({
    id: `chat:${r.sessionId}:${r.messageId ?? i}`,
    label: r.title,
    icon: MessageSquare,
    meta: projects.find((p) => p.id === r.projectId)?.managed
      ? tr("Без проекта")
      : projects.find((p) => p.id === r.projectId)?.name,
    result: r,
    run: () => choose(r),
  }));
  const settingsItems: Item[] = categories
    .filter(
      (c) =>
        !settingsQuery.trim() ||
        `${tr(c.title)} ${c.title} ${tr(c.description)} ${parameters
          .filter((p) => p.category === c.id)
          .map((p) => `${tr(p.title)} ${p.title} ${p.keywords ?? ""}`)
          .join(" ")}`
          .toLocaleLowerCase()
          .includes(settingsQuery.trim().toLocaleLowerCase()),
    )
    .map((c) => ({
      id: `setting:${c.id}`,
      label: tr(c.title),
      icon: c.icon,
      run: () => openSettings(c.id),
    }));
  const items = settingsMode ? settingsItems : [...chats, ...actions];
  const boundedSelected = Math.min(selected, Math.max(0, items.length - 1));
  useEffect(() => {
    list.current
      ?.querySelector(`[data-palette-index="${boundedSelected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [boundedSelected]);
  async function activate(item: Item | undefined) {
    if (!item || choosing.current) return;
    choosing.current = true;
    setOpening(true);
    try {
      await item.run();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      choosing.current = false;
      setOpening(false);
    }
  }
  function keydown(event: KeyboardEvent) {
    if (
      (event.target as HTMLElement).closest('[role="menu"]') ||
      event.nativeEvent.isComposing
    )
      return;
    if (event.key === "Escape" && settingsMode) {
      event.preventDefault();
      event.stopPropagation();
      setSettingsMode(false);
      setSelected(0);
      input.current?.focus();
      return;
    }
    if ((event.target as HTMLElement).closest('button:not([role="option"])'))
      return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setSelected(
        (boundedSelected +
          (event.key === "ArrowDown" ? 1 : -1) +
          items.length) %
          Math.max(1, items.length),
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (!event.repeat) void activate(items[boundedSelected]);
    } else if (event.altKey && /^[1-9]$/.test(event.key) && !settingsMode) {
      event.preventDefault();
      void activate(chats[Number(event.key) - 1]);
    } else if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === "n" &&
      !settingsMode
    ) {
      event.preventDefault();
      void activate(allActions.find((a) => a.id === "new"));
    } else if ((event.ctrlKey || event.metaKey) && event.key === ",") {
      event.preventDefault();
      void activate(allActions.find((a) => a.id === "settings"));
    } else if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === "k"
    ) {
      event.preventDefault();
      close();
    }
  }
  function mark(value: string) {
    const text = settingsMode ? settingsQuery.trim() : query.trim(),
      at = value.toLocaleLowerCase().indexOf(text.toLocaleLowerCase());
    return at < 0 || !text ? (
      value
    ) : (
      <>
        {value.slice(0, at)}
        <mark>{value.slice(at, at + text.length)}</mark>
        {value.slice(at + text.length)}
      </>
    );
  }
  function row(item: Item, index: number) {
    const Icon = item.icon,
      isSelected = boundedSelected === index,
      snippet = item.result?.messageId ? item.result.snippet : undefined;
    return (
      <button
        key={item.id}
        id={`palette-item-${index}`}
        data-palette-index={index}
        role="option"
        aria-selected={isSelected}
        className={`palette-row ${isSelected ? "selected" : ""} ${snippet ? "has-snippet" : ""}`}
        onMouseMove={() => setSelected(index)}
        onClick={() => void activate(item)}
        disabled={opening}
      >
        <Icon className="palette-row-icon" size={14} />
        <span className="palette-row-copy">
          <span className="palette-row-title">{mark(item.label)}</span>
          {snippet && <span className="palette-snippet">{mark(snippet)}</span>}
        </span>
        {item.meta && (
          <span className="palette-row-project" title={item.meta}>
            {item.meta}
          </span>
        )}
        {item.result && index < 9 ? (
          <kbd className="palette-shortcut">Alt {index + 1}</kbd>
        ) : item.shortcut ? (
          <kbd className="palette-shortcut">{item.shortcut}</kbd>
        ) : !item.result ? (
          <ArrowUpRight size={12} className="palette-row-tail" />
        ) : null}
      </button>
    );
  }
  return (
    <Modal
      title={tr("Поиск диалогов")}
      close={close}
      headerless
      backdropClassName="history-backdrop"
      className="history-dialog command-palette"
    >
      <div className="palette-body" onKeyDown={keydown}>
        <div className="palette-input-line">
          {settingsMode ? (
            <IconButton
              label={tr("Назад к поиску")}
              onClick={() => {
                setSettingsMode(false);
                setSelected(0);
                input.current?.focus();
              }}
            >
              <ArrowLeft size={16} />
            </IconButton>
          ) : (
            <Search className="palette-search-icon" size={16} />
          )}
          <input
            ref={input}
            data-autofocus
            autoFocus
            role="combobox"
            aria-label={tr("Поиск по истории")}
            aria-expanded="true"
            aria-controls="palette-results"
            aria-activedescendant={
              items.length ? `palette-item-${boundedSelected}` : undefined
            }
            autoComplete="off"
            spellCheck={false}
            placeholder={
              settingsMode
                ? tr("Найти настройку…")
                : tr("Поиск чатов и команд…")
            }
            value={settingsMode ? settingsQuery : query}
            onChange={(event) => {
              setSelected(0);
              if (settingsMode) setSettingsQuery(event.target.value);
              else {
                setResults([]);
                setQuery(event.target.value);
              }
            }}
          />
          {(loading || opening) && (
            <LoaderCircle size={14} className="spin palette-loading" />
          )}
          <IconButton label={tr("Закрыть поиск")} onClick={close}>
            <X size={15} />
          </IconButton>
        </div>
        {!settingsMode && (
          <div className="palette-context">
            <span className="palette-workspace">
              <span />
              {workspace === "chat" ? "Chat Faction" : "Work Faction"}
            </span>
            <HistoryProjectFilter
              projects={projects}
              value={projectId}
              onChange={(id) => {
                setResults([]);
                setProjectId(id);
                setSelected(0);
                input.current?.focus();
              }}
            />
          </div>
        )}
        <div
          id="palette-results"
          className="palette-results"
          ref={list}
          role="listbox"
          aria-label={tr("Результаты поиска")}
          aria-busy={loading}
        >
          {settingsMode ? (
            <>
              <div className="palette-section-label">{tr("Настройки")}</div>
              {settingsItems.map(row)}
            </>
          ) : (
            <>
              {!!chats.length && (
                <>
                  <div className="palette-section-label">
                    {normalized ? tr("Диалоги") : tr("Недавние чаты")}
                  </div>
                  {chats.map(row)}
                </>
              )}
              {!chats.length && !loading && (
                <div className="palette-empty">
                  <MessageSquare size={20} />
                  <span>
                    {normalized
                      ? tr("Диалоги не найдены")
                      : tr("Здесь появятся ваши чаты")}
                  </span>
                  <small>
                    {normalized
                      ? tr(
                          "Попробуйте другое название, текст сообщения или проект.",
                        )
                      : tr("Начните разговор или откройте проект.")}
                  </small>
                </div>
              )}
              {loading && !chats.length && (
                <div className="palette-searching" role="status">
                  {tr("Ищем в истории…")}
                </div>
              )}
              {!!actions.length && (
                <>
                  <div className="palette-section-label">
                    {tr("Быстрые действия")}
                  </div>
                  {actions.map((item, i) => row(item, chats.length + i))}
                </>
              )}
            </>
          )}
          {settingsMode && !settingsItems.length && (
            <div className="palette-empty">
              <Settings2 size={20} />
              <span>{tr("Настройка не найдена")}</span>
              <small>{tr("Попробуйте «шрифт», «модели» или «память».")}</small>
            </div>
          )}
          {error && (
            <p className="history-inline-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="palette-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> {tr(" выбрать")}{" "}
            <kbd>
              <CornerDownLeft size={10} />
            </kbd>{" "}
            {tr("открыть")}
          </span>
          <span>
            <kbd>Esc</kbd> {settingsMode ? tr("назад") : tr("закрыть")}
          </span>
        </div>
      </div>
    </Modal>
  );
}
