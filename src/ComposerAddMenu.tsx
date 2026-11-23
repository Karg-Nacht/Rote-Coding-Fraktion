import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Blocks,
  BookOpen,
  Check,
  Code2,
  Folder,
  FolderPlus,
  Lightbulb,
  LoaderCircle,
  MessageSquare,
  Paperclip,
  Plug,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import type { Capabilities, Session, Workspace } from "../shared/types";
import { api, useApp } from "./store";
import { IconButton, Modal } from "./components";
import { ComposerSurface } from "./ComposerSurface";
import { tr, trf, useLanguage } from "./i18n";
import { CustomSelect } from "./CustomSelect";

export function ComposerAddMenu({
  disabled,
  running,
  surfaceAnchor,
  projectId,
  workspace,
  planning,
  setPlanning,
  skills,
  setSkills,
  onFiles,
  onFolder,
  onText,
}: {
  disabled: boolean;
  running: boolean;
  surfaceAnchor: RefObject<HTMLElement | null>;
  projectId?: string;
  workspace: Workspace;
  planning: boolean;
  setPlanning: (value: boolean) => void;
  skills: string[];
  setSkills: (value: string[]) => void;
  onFiles: () => void;
  onFolder: () => void;
  onText: (name: string, text: string) => Promise<void>;
}) {
  useLanguage();
  const { sessions, snapshot } = useApp();
  const anchor = useRef<HTMLButtonElement>(null),
    search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState("");
  const [capabilities, setCapabilities] = useState<Capabilities>(),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const [connecting, setConnecting] = useState<string>(),
    [addingChat, setAddingChat] = useState<string>();
  const [context, setContext] = useState(false),
    [name, setName] = useState(""),
    [text, setText] = useState(""),
    [saving, setSaving] = useState(false);
  const [mcpForm, setMcpForm] = useState(false);
  const sequence = useRef(0);
  const close = () => setOpen(false);
  async function load() {
    const request = ++sequence.current;
    setLoading(true);
    setError("");
    try {
      const value = await api.capabilities(projectId);
      if (request === sequence.current) setCapabilities(value);
    } catch (e) {
      if (request === sequence.current)
        setError(String(e instanceof Error ? e.message : e));
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    if (open) void load();
    return () => {
      sequence.current++;
    };
  }, [open, projectId]);
  const action = (fn: () => void) => {
    close();
    fn();
  };
  const matches = (...values: string[]) =>
    !query.trim() ||
    values
      .join(" ")
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase());
  const statusName = (status: string) =>
    ({
      connected: tr("Подключён"),
      active: tr("Подключён"),
      disabled: tr("Отключён"),
      failed: tr("Ошибка подключения"),
      needs_auth: tr("Нужна авторизация"),
      pending: tr("Подключение…"),
    })[status] ?? status;
  const availableSkills =
    capabilities?.skills.filter((s) => matches(s.name, s.description)) ?? [];
  const servers =
    capabilities?.mcp.filter((s) => matches(s.name, s.title)) ?? [];
  const plugins =
    capabilities?.plugins.filter(
      (p) => !p.id.startsWith("opencode.") && matches(p.id),
    ) ?? [];
  const chats = sessions
    .filter(
      (s) =>
        !s.parentId &&
        s.id !== snapshot?.session.id &&
        matches(
          s.title,
          s.workspace === "chat" ? "Chat Faction" : "Work Faction",
        ),
    )
    .slice(0, 40);
  async function attachChat(session: Session) {
    setAddingChat(session.id);
    setError("");
    try {
      const value = await api.refreshSession(session.id);
      const parts = value.rows
        .filter((row) => row.type === "user" || row.type === "text")
        .map(
          (row) =>
            `${row.type === "user" ? tr("Вы") : "Rote Coding Fraktion"}:\n${"text" in row ? row.text : ""}`,
        );
      if (!parts.length)
        throw new Error(tr("В этом чате пока нет текстовых сообщений."));
      const content = `${session.title}\n${session.workspace === "chat" ? "Chat Faction" : "Work Faction"}\n${tr("Последние сообщения · только текст, без вложений и действий инструментов.")}\n\n${parts.join("\n\n").slice(-60000)}`;
      await onText(session.title, content);
      close();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setAddingChat(undefined);
    }
  }
  function row(
    label: string,
    description: string,
    icon: ReactNode,
    onClick: () => void,
    options: { disabled?: boolean; role?: "switch"; checked?: boolean } = {},
  ) {
    if (!matches(label, description)) return null;
    return (
      <button
        data-panel-item
        className={`add-list-row ${options.checked ? "chosen" : ""}`}
        aria-label={label}
        title={description}
        onClick={onClick}
        disabled={options.disabled}
        role={options.role}
        aria-checked={options.checked}
      >
        {icon}
        <strong>{label}</strong>
        <span className="add-row-description">{description}</span>
        {options.checked && <Check size={13} className="add-row-check" />}
      </button>
    );
  }
  const actions = [
    row(
      tr("Файлы и папки"),
      tr("Изображения, PDF и текст"),
      <Paperclip size={15} />,
      () => action(onFiles),
    ),
    row(
      tr("Прикрепить папку"),
      tr("Структура папки, без содержимого файлов"),
      <FolderPlus size={15} className="folder-color" />,
      () => action(onFolder),
    ),
    row(
      tr("Контекст кода или команды"),
      tr("Прикрепить текст для разбора"),
      <Code2 size={15} />,
      () =>
        action(() => {
          setContext(true);
          setName("");
          setText("");
          setError("");
        }),
    ),
    row(
      tr("Работать в проекте"),
      tr("Выбрать папку для этого чата"),
      <Folder size={15} />,
      () =>
        action(() =>
          window.dispatchEvent(new CustomEvent("forge:project-picker")),
        ),
      { disabled: running },
    ),
    row(
      tr("Режим планирования"),
      workspace === "chat"
        ? tr("Доступен в Work Faction")
        : planning
          ? tr("Выключить режим планирования")
          : tr("Изучить проект и составить план"),
      <Lightbulb size={15} />,
      () => action(() => setPlanning(!planning)),
      {
        disabled: workspace === "chat" || running,
        role: "switch",
        checked: planning,
      },
    ),
  ].filter(Boolean);
  const addMcp = matches("MCP", tr("Добавить сервер MCP"));
  return (
    <>
      <span className="composer-add-anchor">
        <button
          ref={anchor}
          className={`icon-button composer-add-trigger ${open ? "active" : ""}`}
          aria-label={tr("Добавить файлы и возможности")}
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => {
            setOpen(!open);
            setQuery("");
          }}
        >
          <Plus size={19} />
        </button>
        {!open && (
          <span className="composer-add-tooltip" role="tooltip">
            {tr("Добавить файлы и другое")}
          </span>
        )}
      </span>
      <ComposerSurface
        open={open}
        anchor={anchor}
        alignTo={surfaceAnchor}
        close={close}
        label={tr("Добавить к сообщению")}
        className="composer-add-panel"
      >
        <div
          className="add-menu-content"
          onKeyDown={(event) => {
            if (event.target instanceof HTMLInputElement) return;
            if (
              event.key.length === 1 &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.altKey
            ) {
              event.preventDefault();
              setQuery((value) => value + event.key);
              search.current?.focus();
            }
          }}
        >
          {!!actions.length && (
            <section className="add-list-section" aria-label={tr("Добавить")}>
              <div className="add-list-heading">{tr("Добавить")}</div>
              {actions.map((item, i) => (
                <div key={i}>{item}</div>
              ))}
            </section>
          )}
          {(!query || plugins.length > 0) && (
            <section className="add-list-section" aria-label={tr("Плагины")}>
              <div className="add-list-heading">{tr("Плагины")}</div>
              {plugins.map((p) => (
                <div className="add-list-row add-installed-plugin" key={p.id}>
                  <Blocks size={15} />
                  <strong>{p.id}</strong>
                  <span className="add-row-description">
                    {statusName(p.status)}
                  </span>
                </div>
              ))}
              {!plugins.length && (
                <div className="add-list-note">
                  {tr("Каталог плагинов готовится")}
                </div>
              )}
            </section>
          )}
          {!!availableSkills.length && (
            <section className="add-list-section" aria-label={tr("Навыки")}>
              <div className="add-list-heading">{tr("Навыки")}</div>
              {availableSkills.map((s) => (
                <button
                  data-panel-item
                  key={s.id}
                  className={`add-list-row ${skills.includes(s.id) ? "chosen" : ""}`}
                  role="checkbox"
                  aria-checked={skills.includes(s.id)}
                  title={s.description}
                  disabled={!skills.includes(s.id) && skills.length >= 20}
                  onClick={() =>
                    setSkills(
                      skills.includes(s.id)
                        ? skills.filter((id) => id !== s.id)
                        : [...skills, s.id],
                    )
                  }
                >
                  <BookOpen size={15} />
                  <strong>{s.name}</strong>
                  <span className="add-row-description">{s.description}</span>
                  {skills.includes(s.id) && (
                    <Check size={13} className="add-row-check" />
                  )}
                </button>
              ))}
            </section>
          )}
          {(servers.length > 0 || addMcp) && (
            <section className="add-list-section" aria-label="MCP">
              <div className="add-list-heading">MCP</div>
              {servers.map((s) => (
                <button
                  data-panel-item
                  className="add-list-row"
                  key={s.name}
                  disabled={!!connecting}
                  aria-label={`${s.status === "connected" ? tr("Отключить") : tr("Подключить")} ${s.title}`}
                  onClick={() => {
                    setConnecting(s.name);
                    void api
                      .connectMcp(s.name, s.status !== "connected", projectId)
                      .then(load)
                      .catch((e) => setError(String(e.message ?? e)))
                      .finally(() => setConnecting(undefined));
                  }}
                >
                  <Plug size={15} />
                  <strong>{s.title}</strong>
                  <span className="add-row-description">
                    {statusName(s.status)}
                  </span>
                  {connecting === s.name ? (
                    <LoaderCircle size={13} className="spin" />
                  ) : s.status === "connected" ? (
                    <Check size={13} />
                  ) : null}
                </button>
              ))}
              {addMcp &&
                row(
                  tr("Добавить сервер MCP"),
                  tr("Инструменты и источники контекста"),
                  <Plus size={15} />,
                  () => action(() => setMcpForm(true)),
                )}
            </section>
          )}
          {!!chats.length && (
            <section className="add-list-section" aria-label={tr("Чаты RCF")}>
              <div className="add-list-heading">{tr("Чаты RCF")}</div>
              {chats.map((s) => (
                <button
                  data-panel-item
                  className="add-list-row add-chat-row"
                  key={s.id}
                  aria-label={trf`Прикрепить чат ${s.title}`}
                  title={s.title}
                  disabled={!!addingChat}
                  onClick={() => void attachChat(s)}
                >
                  <MessageSquare size={15} />
                  <strong>{s.title}</strong>
                  <span className="add-row-description">
                    {s.workspace === "chat" ? "Chat Faction" : "Work Faction"}
                  </span>
                  {addingChat === s.id && (
                    <LoaderCircle className="spin" size={13} />
                  )}
                </button>
              ))}
            </section>
          )}
          {loading && (
            <div className="add-list-note" role="status">
              <LoaderCircle className="spin" size={13} />
              {tr("Загрузка…")}
            </div>
          )}
          {!loading &&
            !actions.length &&
            !availableSkills.length &&
            !servers.length &&
            !plugins.length &&
            !chats.length &&
            !addMcp && (
              <div className="add-list-note">{tr("Ничего не найдено")}</div>
            )}
          {(error || !!capabilities?.errors.length) && (
            <div className="surface-error" role="alert">
              {error ||
                tr("Не удалось обновить этот раздел. Попробуйте ещё раз.")}
            </div>
          )}
          <div className="add-list-search">
            <Search size={13} />
            <input
              ref={search}
              aria-label={tr("Поиск действий и контекста")}
              placeholder={tr("Найти действие, навык или чат…")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <IconButton
              label={tr("Обновить возможности")}
              disabled={loading}
              onClick={() => void load()}
            >
              <RefreshCw size={12} className={loading ? "spin" : ""} />
            </IconButton>
          </div>
        </div>
      </ComposerSurface>
      {context && (
        <Modal
          title={tr("Контекст кода или команды")}
          close={() => setContext(false)}
          className="composer-context-dialog"
        >
          <div className="context-text-form">
            <p>
              {tr(
                "Контекст передаётся как текстовое вложение. Команды не запускаются.",
              )}
            </p>
            <input
              aria-label={tr("Название контекста")}
              placeholder={tr("Название, например: вывод команды")}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <textarea
              data-autofocus
              aria-label={tr("Текст контекста")}
              placeholder={tr("Вставьте код, команду или её вывод…")}
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={100000}
            />
            <button
              className="primary"
              disabled={saving || !text.trim()}
              onClick={() => {
                setSaving(true);
                void onText(name.trim() || "context", text)
                  .then(() => setContext(false))
                  .catch((e) => setError(String(e.message ?? e)))
                  .finally(() => setSaving(false));
              }}
            >
              {saving ? tr("Добавление…") : tr("Прикрепить контекст")}
            </button>
            {error && (
              <p className="surface-error" role="alert">
                {error}
              </p>
            )}
          </div>
        </Modal>
      )}
      {mcpForm && (
        <McpForm
          projectId={projectId}
          close={() => setMcpForm(false)}
          saved={() => {
            setMcpForm(false);
            setQuery("");
            setOpen(true);
          }}
        />
      )}
    </>
  );
}

function McpForm({
  projectId,
  close,
  saved,
}: {
  projectId?: string;
  close: () => void;
  saved: () => void;
}) {
  useLanguage();
  const [type, setType] = useState<"remote" | "local">("remote"),
    [name, setName] = useState(""),
    [value, setValue] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal title={tr("Добавить сервер MCP")} close={close}>
      <form
        className="context-text-form"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          void (async () => {
            const command: unknown =
              type === "local" ? JSON.parse(value) : undefined;
            if (
              type === "local" &&
              (!Array.isArray(command) ||
                !command.length ||
                command.some((v) => typeof v !== "string"))
            )
              throw new Error(tr("Введите команду в виде JSON-массива строк."));
            await api.addMcp(
              {
                name: name.trim(),
                type,
                ...(type === "remote"
                  ? { url: value.trim() }
                  : { command: command as string[] }),
              },
              projectId,
            );
            saved();
          })()
            .catch((e) => setError(String(e.message ?? e)))
            .finally(() => setBusy(false));
        }}
      >
        <label>
          {tr("Имя сервера")}
          <input
            data-autofocus
            required
            pattern="[a-zA-Z0-9_-]{1,60}"
            aria-label={tr("Имя сервера MCP")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="project-tools"
          />
        </label>
        <label>
          {tr("Тип подключения")}
          <CustomSelect
            aria-label={tr("Тип подключения MCP")}
            value={type}
            onChange={(value) => {
              setType(value as typeof type);
              setValue("");
            }}
            options={[
              { value: "remote", label: tr("Удалённый · HTTP") },
              { value: "local", label: tr("Локальный · stdio") },
            ]}
          />
        </label>
        <label>
          {type === "remote" ? "URL" : tr("Команда запуска")}
          <input
            required
            aria-label={tr("Адрес или команда MCP")}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={
              type === "remote"
                ? "https://example.com/mcp"
                : '["node", "C:/tools/server.mjs"]'
            }
          />
        </label>
        <p>
          {tr(
            "Сервер сохранится отключённым. Подключите его отдельной кнопкой в списке MCP.",
          )}
        </p>
        {error && (
          <p className="surface-error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          {busy ? tr("Сохранение…") : tr("Сохранить сервер")}
        </button>
      </form>
    </Modal>
  );
}
