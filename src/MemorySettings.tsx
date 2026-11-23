import { useCallback, useEffect, useRef, useState } from "react";
import {
  Brain,
  Check,
  FolderOpen,
  Globe2,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type { MemoryEntry } from "../shared/types";
import { MEMORY_TEXT_LIMIT } from "../shared/workspaces";
import { IconButton, Modal } from "./components";
import { CustomSelect } from "./CustomSelect";
import { tr, trf, useLanguage } from "./i18n";
import {
  SettingRow,
  SettingsConfirmation,
  SettingsDisclosure,
  Toggle,
} from "./SettingsControls";
import { api, useApp } from "./store";
import "./memory-settings.css";

type Draft = Pick<MemoryEntry, "scope" | "projectId" | "text"> & {
  id?: string;
};
type Panel =
  { mode: "read"; entry: MemoryEntry } | { mode: "edit"; draft: Draft };
type Deletion = { entries: MemoryEntry[]; all: boolean };

const normalize = (text: string) => text.toLocaleLowerCase("ru");
const singleLine = (text: string) => text.replace(/\s+/g, " ").trim();

function summarize(text: string, query = "") {
  const [first, ...lines] = text.trim().split(/\r?\n/);
  const lead = singleLine(first.replace(/^(?:#{1,6}|[-*+])\s+/, "")) || first;
  const end = lead.search(/[.!?…](?=\s|$)/);
  const sentence = end < 0 ? lead : lead.slice(0, end + 1);
  const cut = Array.from(sentence).slice(0, 68).join("");
  const prefix = cut === sentence ? cut : cut.replace(/\s+\S{0,14}$/, "");
  const title = prefix === sentence ? prefix : prefix + "…";
  let preview = singleLine([lead.slice(prefix.length), ...lines].join(" "));
  if (query && !normalize(title).includes(query)) {
    const flat = singleLine(text);
    const match = normalize(flat).indexOf(query);
    if (match >= 0) {
      const start = Math.max(0, match - 18);
      preview = (start ? "…" : "") + flat.slice(start);
    }
  }
  return { title, preview };
}

function errorMessage(cause: unknown) {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.replace(/^Error invoking remote method '[^']+': Error: /, "");
}

function EntryMeta({
  entry,
  projectName,
  id,
}: {
  entry: MemoryEntry;
  projectName?: string;
  id?: string;
}) {
  const language = useLanguage();
  const date = new Date(entry.updated);
  const ScopeIcon = entry.scope === "global" ? Globe2 : FolderOpen;
  return (
    <span className="memory-entry-meta" id={id}>
      <span className="memory-entry-scope" title={projectName}>
        <ScopeIcon size={12} aria-hidden="true" />
        <span>
          {entry.scope === "global"
            ? tr("Общая память")
            : (projectName ?? tr("Память проекта"))}
        </span>
      </span>
      {entry.updated > 0 && Number.isFinite(date.getTime()) && (
        <time dateTime={date.toISOString()} title={tr("Дата изменения")}>
          {date.toLocaleDateString(language === "en" ? "en-US" : "ru-RU", {
            day: "numeric",
            month: "short",
            year: "numeric",
          })}
        </time>
      )}
    </span>
  );
}

export function MemorySettings({
  onEnabledChange,
}: {
  onEnabledChange: (enabled: boolean) => void;
}) {
  useLanguage();
  const { projects: allProjects, preferences } = useApp();
  const projects = allProjects.filter((project) => !project.managed);
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [scope, setScope] = useState("global");
  const [query, setQuery] = useState("");
  const [panel, setPanel] = useState<Panel>();
  const [deleting, setDeleting] = useState<Deletion>();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const sequence = useRef(0);
  const search = useRef<HTMLInputElement>(null);
  const reader = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const reload = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true);
    setLoadError("");
    try {
      const next = await api.listMemory();
      if (request === sequence.current) setEntries(next);
    } catch (cause) {
      if (request === sequence.current) setLoadError(errorMessage(cause));
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    return () => {
      sequence.current++;
    };
  }, [reload]);

  const dialogOpen = !!(panel || deleting);
  const panelMode = panel?.mode;
  useEffect(() => {
    if (panelMode === "read") reader.current?.focus({ preventScroll: true });
    // The shared dialog stays mounted when switching from reading to editing.
    if (panelMode === "edit") editor.current?.focus();
  }, [panelMode]);
  useEffect(() => {
    if (!dialogOpen) return;
    return () => {
      // The dialog restores its trigger. Fall back if the trigger was removed.
      queueMicrotask(() => {
        if (document.activeElement === document.body) search.current?.focus();
      });
    };
  }, [dialogOpen]);

  const disconnected = new Set<string>();
  const projectOptions = projects.map((project) => ({
    value: project.id, label: project.name, group: tr("Память проекта"),
  }));
  const isConnected = (id?: string) =>
    projects.some((project) => project.id === id);
  const disconnectedScope = scope !== "global" && !isConnected(scope);
  if (disconnectedScope) disconnected.add(scope);
  for (const entry of entries) {
    if (entry.projectId && !isConnected(entry.projectId))
      disconnected.add(entry.projectId);
  }
  const scoped = entries.filter((entry) =>
    scope === "global"
      ? entry.scope === "global"
      : entry.scope === "project" && entry.projectId === scope,
  );
  const needle = normalize(query.trim());
  const visible = scoped
    .filter((entry) => normalize(entry.text).includes(needle))
    .sort((a, b) => b.updated - a.updated);

  function clearSearch() {
    setQuery("");
    search.current?.focus();
  }

  function openEditor(entry?: MemoryEntry) {
    setActionError("");
    setNotice("");
    setPanel({
      mode: "edit",
      draft: entry
        ? {
            id: entry.id,
            scope: entry.scope,
            projectId: entry.projectId,
            text: entry.text,
          }
        : {
            scope: scope === "global" ? "global" : "project",
            projectId: scope === "global" ? undefined : scope,
            text: "",
          },
    });
  }

  function requestDeletion(targets: MemoryEntry[], all = false) {
    setActionError("");
    setNotice("");
    setDeleting({ entries: targets, all });
  }

  const draft = panel?.mode === "edit" ? panel.draft : undefined;
  const viewing = panel?.mode === "read" ? panel.entry : undefined;

  async function save() {
    if (!draft || busy || !draft.text.trim()) return;
    setBusy(true);
    setActionError("");
    try {
      const entry = await api.saveMemory(draft);
      setEntries((current) => [
        ...current.filter((item) => item.id !== entry.id),
        entry,
      ]);
      setScope(entry.projectId ?? "global");
      setPanel(undefined);
      setNotice(tr("Запись памяти сохранена"));
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!deleting || busy) return;
    setBusy(true);
    setActionError("");
    let removed = 0;
    try {
      for (const entry of deleting.entries) {
        await api.deleteMemory(entry.id);
        removed++;
        setEntries((current) => current.filter((item) => item.id !== entry.id));
      }
      setDeleting(undefined);
      setNotice(tr("Записи памяти удалены"));
    } catch (cause) {
      setDeleting({ ...deleting, entries: deleting.entries.slice(removed) });
      setActionError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  function closePanel() {
    if (!busy) setPanel(undefined);
  }

  return (
    <div className="memory-settings">
      <div className="memory-controls">
        <SettingRow
          id="memory-enabled"
          title={tr("Использовать долговременную память")}
          description={tr("Добавлять сохранённые записи к новым запросам.")}
        >
          <Toggle
            id="memory-enabled"
            value={preferences.memoryEnabled !== false}
            change={onEnabledChange}
          />
        </SettingRow>
        <SettingsDisclosure id="memory-help" title={tr("Как работает память")}>
          <p>
            {tr(
              "Общие записи доступны в Work Faction и Chat Faction. Память проекта добавляется только при работе с соответствующим проектом",
            )}
            .
          </p>
          <p>
            {tr(
              "Записи добавляются только по вашему действию. Автоматическое запоминание выключено: документы, ответы моделей и содержимое репозиториев сами по себе не становятся памятью. Не добавляйте ключи, пароли, токены и содержимое .env.",
            )}
          </p>
        </SettingsDisclosure>
      </div>

      <section
        className="memory-collection"
        id="setting-memory-records"
        aria-labelledby="memory-collection-title"
        tabIndex={-1}
      >
        <div className="memory-toolbar">
          <div className="memory-collection-heading">
            <h3 id="memory-collection-title">{tr("Записи памяти")}</h3>
            <span className="memory-count" role="status">
              {needle
                ? trf`${visible.length} из ${scoped.length}`
                : scoped.length}
            </span>
          </div>
          <div className="memory-toolbar-actions">
            <IconButton
              className="memory-refresh"
              label={tr("Обновить память")}
              disabled={busy || loading}
              onClick={() => void reload()}
            >
              <RefreshCw size={15} className={loading ? "spin" : undefined} />
            </IconButton>
            <button
              className="primary"
              disabled={busy || loading || disconnectedScope}
              onClick={() => openEditor()}
            >
              <Plus size={15} aria-hidden="true" />
              {tr("Добавить запись")}
            </button>
          </div>
        </div>

        <div className="memory-filters">
          <label className="field">
            <span id="memory-scope-label">{tr("Область памяти")}</span>
            <CustomSelect
              aria-labelledby="memory-scope-label"
              value={scope}
              onChange={(value) => {
                setScope(value);
                setNotice("");
              }}
              options={[
                { value: "global", label: tr("Общая память") },
                ...projectOptions,
                ...[...disconnected].map((id) => ({
                  value: id,
                  label: tr("Отключённый проект · ") + id.slice(0, 8),
                  group: tr("Память проекта"),
                })),
              ]}
            />
          </label>
          <div className="field">
            <label htmlFor="memory-search">{tr("Поиск записей памяти")}</label>
            <div className="search-input">
              <Search size={14} aria-hidden="true" />
              <input
                id="memory-search"
                ref={search}
                placeholder={tr("Найти запись…")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && query) {
                    event.stopPropagation();
                    clearSearch();
                  }
                }}
              />
              {query && (
                <IconButton
                  label={tr("Очистить поиск записей")}
                  onClick={clearSearch}
                >
                  <X size={14} />
                </IconButton>
              )}
            </div>
          </div>
        </div>

        {disconnectedScope && (
          <p className="hint memory-feedback">
            {tr(
              "Проект убран из списка. Его память сохранена: записи можно удалить или перенести в общую память через редактирование.",
            )}
          </p>
        )}
        {loadError && (
          <p className="memory-feedback memory-error" role="alert">
            {loadError}
          </p>
        )}
        {notice && (
          <p className="memory-feedback memory-notice" role="status">
            <Check size={14} aria-hidden="true" />
            {notice}
          </p>
        )}

        <div aria-busy={loading}>
          {visible.length ? (
            <ul className="memory-list" role="list">
              {visible.map((entry) => {
                const { title, preview } = summarize(entry.text, needle);
                return (
                  <li className="memory-entry" key={entry.id}>
                    <button
                      className="memory-entry-open"
                      aria-label={trf`Открыть запись «${title}»`}
                      aria-describedby={`memory-meta-${entry.id}`}
                      aria-haspopup="dialog"
                      onClick={() => setPanel({ mode: "read", entry })}
                    >
                      <span className="memory-entry-copy">
                        <span className="memory-entry-title" title={title}>
                          {title}
                        </span>
                        {preview && (
                          <span className="memory-entry-preview">
                            {preview}
                          </span>
                        )}
                        <EntryMeta
                          entry={entry}
                          id={`memory-meta-${entry.id}`}
                        />
                      </span>
                    </button>
                    <div className="memory-entry-actions">
                      <IconButton
                        label={tr("Редактировать запись памяти")}
                        disabled={busy || loading}
                        onClick={() => openEditor(entry)}
                      >
                        <Pencil size={14} />
                      </IconButton>
                      <IconButton
                        className="memory-delete-icon"
                        label={tr("Удалить запись памяти")}
                        disabled={busy || loading}
                        onClick={() => requestDeletion([entry])}
                      >
                        <Trash2 size={14} />
                      </IconButton>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : loading ? (
            <p className="memory-loading" role="status">
              <LoaderCircle size={16} className="spin" aria-hidden="true" />
              {tr("Загрузка памяти…")}
            </p>
          ) : (
            !loadError && (
              <div className="settings-empty memory-empty">
                {needle ? (
                  <Search size={22} aria-hidden="true" />
                ) : (
                  <Brain size={22} aria-hidden="true" />
                )}
                <h4>
                  {needle ? tr("Записи не найдены") : tr("Пока нет записей")}
                </h4>
                <p>
                  {needle
                    ? tr("Измените запрос или выберите другую область памяти.")
                    : tr(
                        "Добавьте предпочтение или важное правило проекта, чтобы использовать его в следующих разговорах.",
                      )}
                </p>
              </div>
            )
          )}
        </div>

        {!!scoped.length && (
          <div className="memory-clear">
            <span>
              {scope === "global"
                ? tr("Очистить общую память")
                : tr("Очистить память выбранного проекта")}
            </span>
            <button
              className="text-button red"
              disabled={busy || loading}
              onClick={() => requestDeletion(scoped, true)}
            >
              {tr("Удалить записи (")}
              {scoped.length})
            </button>
          </div>
        )}
      </section>

      {panel && (
        <Modal
          title={
            panel.mode === "read"
              ? summarize(panel.entry.text).title
              : panel.draft.id
                ? tr("Редактировать запись")
                : tr("Новая запись")
          }
          close={closePanel}
          className={viewing ? "memory-panel" : "memory-edit-dialog"}
          backdropClassName={viewing ? "memory-panel-backdrop" : "memory-edit-backdrop"}
        >
          <div className="memory-panel-body">
            {viewing && (
              <>
                <EntryMeta
                  entry={viewing}
                  projectName={
                    projects.find((project) => project.id === viewing.projectId)
                      ?.name
                  }
                />
                <div
                  className="memory-full-text"
                  ref={reader}
                  tabIndex={0}
                  role="region"
                  aria-label={tr("Текст записи")}
                >
                  {viewing.text}
                </div>
              </>
            )}
            {draft && (
              <form
                className="memory-editor"
                id="memory-editor"
                onSubmit={(event) => {
                  event.preventDefault();
                  void save();
                }}
              >
                <label className="field">
                  <span id="memory-editor-scope-label">
                    {tr("Использовать в")}
                  </span>
                  <CustomSelect
                    aria-labelledby="memory-editor-scope-label"
                    value={draft.projectId ?? "global"}
                    disabled={busy}
                    onChange={(next) => {
                      setPanel({
                        mode: "edit",
                        draft: {
                          ...draft,
                          scope: next === "global" ? "global" : "project",
                          projectId: next === "global" ? undefined : next,
                        },
                      });
                    }}
                    options={[
                      { value: "global", label: tr("Общая память · все проекты") },
                      ...projectOptions,
                      ...(draft.projectId && !isConnected(draft.projectId)
                        ? [{ value: draft.projectId, label: tr("Проект не подключён · выберите другую область"), disabled: true }]
                        : []),
                    ]}
                  />
                </label>
                <label className="field">
                  <span id="memory-text-label">{tr("Текст записи")}</span>
                  <textarea
                    ref={editor}
                    aria-labelledby="memory-text-label"
                    aria-describedby="memory-text-length"
                    data-autofocus
                    required
                    maxLength={MEMORY_TEXT_LIMIT}
                    rows={7}
                    value={draft.text}
                    disabled={busy}
                    placeholder={tr(
                      "Например: в этом проекте используем npm и TypeScript со строгой проверкой типов.",
                    )}
                    onChange={(event) =>
                      setPanel({
                        mode: "edit",
                        draft: { ...draft, text: event.target.value },
                      })
                    }
                  />
                  <small id="memory-text-length">
                    {draft.text.length} / {MEMORY_TEXT_LIMIT}
                  </small>
                </label>
                {actionError && (
                  <p className="memory-error" role="alert">
                    {actionError}
                  </p>
                )}
              </form>
            )}
          </div>
          <div className="memory-panel-actions" data-select-footer>
            {viewing ? (
              <button className="secondary" onClick={() => openEditor(viewing)}>
                <Pencil size={14} aria-hidden="true" />
                {tr("Редактировать запись")}
              </button>
            ) : (
              draft && (
                <>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={closePanel}
                  >
                    {tr("Отмена")}
                  </button>
                  <button
                    type="submit"
                    form="memory-editor"
                    className="primary"
                    disabled={
                      busy ||
                      !draft.text.trim() ||
                      (draft.scope === "project" &&
                        !isConnected(draft.projectId))
                    }
                  >
                    {busy && (
                      <LoaderCircle
                        className="spin"
                        size={14}
                        aria-hidden="true"
                      />
                    )}
                    {tr("Сохранить запись")}
                  </button>
                </>
              )
            )}
          </div>
        </Modal>
      )}

      {deleting && (
        <SettingsConfirmation
          title={
            deleting.all ? tr("Очистить память?") : tr("Удалить запись памяти?")
          }
          destructive
          busy={busy}
          action={busy ? tr("Удаление…") : tr("Удалить")}
          close={() => setDeleting(undefined)}
          confirm={() => void remove()}
        >
          {!deleting.all && (
            <strong>{summarize(deleting.entries[0].text).title}</strong>
          )}
          <p>
            {deleting.all
              ? trf`Будут удалены записи выбранной области: ${deleting.entries.length}. Это действие нельзя отменить. Существующие чаты сохранятся.`
              : tr(
                  "Запись больше не будет добавляться к новым запросам. Существующие чаты сохранятся.",
                )}
          </p>
          {actionError && (
            <p className="memory-error" role="alert">
              {actionError}
            </p>
          )}
        </SettingsConfirmation>
      )}
    </div>
  );
}
