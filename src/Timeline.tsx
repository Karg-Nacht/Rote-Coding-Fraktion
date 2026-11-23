import { ConversationRail } from "./ConversationRail";
import { tr, useLanguage, trf } from "./i18n";
import {
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowDown,
  Check,
  ChevronRight,
  Clock3,
  ClipboardCheck,
  CircleAlert,
  Copy,
  FileCode2,
  Globe2,
  Image,
  LoaderCircle,
  Shield,
  Terminal,
  Wrench,
  X,
  BookOpen,
  GitBranch,
  Maximize2,
  Pencil,
  Square,
} from "lucide-react";
import type {
  AgentForm,
  ActionFileDiff,
  ImageRef,
  Permission,
  Snapshot,
  TimelineRow,
  ToolItem,
} from "../shared/types";
import { api, attempt, report, useApp } from "./store";
import { IconButton, Modal } from "./components";
import { defaults, Fields, type Answers } from "./Fields";
import { DiffViewer } from "./GitPanel";
import { explainError } from "../shared/errors";
import {
  activityGroups,
  activityKind,
  activityRows,
  toolState,
  type ActivityKind,
} from "../shared/activity";
import {
  ActivityDisplay,
  useActivityDisclosure,
  useActivityDisplay,
} from "./activity-display";
import "./timeline-activity.css";

const expanded = new Map<string, boolean>();
const offsets = new Map<string, number>();
export const duration = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60
    ? trf`${seconds} с`
    : trf`${Math.floor(seconds / 60)} мин ${seconds % 60} с`;
};
const icons = {
  shell: Terminal,
  read: BookOpen,
  edit: FileCode2,
  web: Globe2,
  image: Image,
  other: Wrench,
};
function toolTitle(tool: ToolItem, running: boolean) {
  if (activityKind(tool) === "check")
    return running ? tr("Запускает проверку") : tr("Проверки и тесты");
  if (tool.category === "shell")
    return running ? tr("Выполняет команду") : tr("Команда");
  if (tool.category === "read")
    return running ? tr("Читает файлы") : tr("Чтение");
  if (tool.category === "edit")
    return running ? tr("Изменяет файлы") : tr("Изменение");
  if (tool.childSessionId) return tr("Субагент");
  return tool.name;
}
const groupIcons = { ...icons, check: ClipboardCheck };

function groupTitle(kind: ActivityKind) {
  switch (kind) {
    case "read":
      return tr("Чтение файлов");
    case "edit":
      return tr("Изменение файлов");
    case "shell":
      return tr("Команды");
    case "check":
      return tr("Проверки и тесты");
    case "web":
      return tr("Поиск в интернете");
    default:
      return tr("Другие инструменты");
  }
}
export function ImageGallery({ images }: { images: ImageRef[] }) {
  useLanguage();

  const [current, setCurrent] = useState<ImageRef>();
  return (
    <>
      <div className="image-gallery">
        {images.map((image, i) => (
          <button
            key={`${image.url}:${i}`}
            onClick={() => setCurrent(image)}
            title={image.name}
          >
            <img src={image.url} alt={image.name} loading="lazy" />
          </button>
        ))}
      </div>
      {current && (
        <Modal title={current.name} wide close={() => setCurrent(undefined)}>
          <div className="image-viewer">
            <img src={current.url} alt={current.name} />
          </div>
        </Modal>
      )}
    </>
  );
}
function MarkdownCode({ text, language }: { text: string; language?: string }) {
  const [highlight, setHighlight] = useState<{
    text: string;
    language: string;
    html: string;
  }>();
  useEffect(() => {
    if (!language || text.length > 12000) return;
    let active = true;
    void import("./markdown-highlight")
      .then(({ highlightCode }) => highlightCode(text, language))
      .then((html) => {
        if (active && html) setHighlight({ text, language, html });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [text, language]);
  return (
    <div className="markdown-code">
      <div className="markdown-code-tools">
        <span>{language}</span>
        <IconButton
          label={tr("Копировать код")}
          onClick={() => void attempt(() => api.copyText(text))}
        >
          <Copy size={13} />
        </IconButton>
      </div>
      {highlight?.text === text && highlight.language === language ? (
        <div
          className="markdown-code-highlight"
          dangerouslySetInnerHTML={{ __html: highlight.html }}
        />
      ) : (
        <pre tabIndex={0}>
          <code>{text}</code>
        </pre>
      )}
    </div>
  );
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  useLanguage();

  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ node, children }) => {
            const code = node?.children[0];
            if (code?.type !== "element" || code.tagName !== "code")
              return <pre>{children}</pre>;
            return (
              <MarkdownCode
                text={code.children
                  .map((node) => (node.type === "text" ? node.value : ""))
                  .join("")}
                language={
                  String(code.properties.className ?? "").match(
                    /language-([^\s,]+)/,
                  )?.[1]
                }
              />
            );
          },
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault();
                if (href) void attempt(() => api.openExternal(href));
              }}
            >
              {children}
            </a>
          ),
          img: ({ src, alt }) =>
            src &&
            (/^data:image\//.test(src) || src.startsWith("forge-media:")) ? (
              <ImageGallery
                images={[{ url: src, name: alt ?? tr("Изображение") }]}
              />
            ) : (
              <a
                href={src}
                onClick={(e) => {
                  e.preventDefault();
                  if (src) void attempt(() => api.openExternal(src));
                }}
              >
                {alt ?? tr("Открыть изображение")}
              </a>
            ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
function LogViewer({ text, scope }: { text: string; scope: string }) {
  useLanguage();

  const scroll = useRef<HTMLDivElement>(null);
  const { open: full, toggle } = useActivityDisclosure(`log:${scope}`);
  const preview = useMemo(() => {
    const prefix = text.slice(0, 8192);
    const lines = prefix.split("\n");
    return {
      text: lines.slice(0, 12).join("\n"),
      limited: prefix.length < text.length || lines.length > 12,
    };
  }, [text]);
  const lines = useMemo(() => (full ? text.split("\n") : []), [full, text]);
  const virtual = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 19,
    overscan: 8,
  });
  return (
    <>
      {!full || lines.length <= 150 ? (
        <pre tabIndex={0}>
          {(full ? text : preview.text) || tr("Вывод отсутствует")}
        </pre>
      ) : (
        <div
          className="virtual-log"
          ref={scroll}
          tabIndex={0}
          role="region"
          aria-label={tr("Вывод инструмента")}
        >
          <div
            style={{
              height: virtual.getTotalSize(),
              position: "relative",
              minWidth: "100%",
            }}
          >
            {virtual.getVirtualItems().map((row) => (
              <div
                key={row.key}
                style={{
                  position: "absolute",
                  top: row.start,
                  height: row.size,
                  whiteSpace: "pre",
                  fontFamily: "var(--mono)",
                }}
              >
                {lines[row.index] || " "}
              </div>
            ))}
          </div>
        </div>
      )}
      {preview.limited && (
        <button
          type="button"
          className="text-button tool-log-toggle"
          aria-expanded={full}
          onClick={toggle}
        >
          {full ? tr("Свернуть вывод") : tr("Показать сохранённый вывод")}
        </button>
      )}
    </>
  );
}
const ToolBlock = memo(function ToolBlock({
  tool,
  waiting,
}: {
  tool: ToolItem;
  waiting: boolean;
}) {
  useLanguage();

  const { open, toggle } = useActivityDisclosure(`tool:${tool.id}`);
  const child = useApp((s) =>
    s.sessions.find((session) => session.id === tool.childSessionId),
  );
  const Icon = icons[tool.category];
  const actual = toolState(tool);
  const status = actual === "running" && waiting ? "waiting" : actual;
  const busy = status === "running";
  const statusLabel =
    status === "waiting"
      ? tr("Ожидает подтверждения")
      : status === "running"
        ? tr("Выполняется")
        : status === "error"
          ? tr("Ошибка")
          : status === "interrupted"
            ? tr("Остановлено")
            : status === "completed"
              ? tr("Завершено")
              : tr("Итог неизвестен");
  const subject =
    tool.path?.display ??
    (tool.command || (tool.title !== tool.name ? tool.title : ""));
  const result = (
    <div className="tool-detail">
      <div className="tool-detail-title">
        <span>{tool.name}</span>
        <div className="tool-copy">
          {tool.command && (
            <button
              className="text-button"
              onClick={() => void attempt(() => api.copyText(tool.command!))}
            >
              {tr("Копировать команду")}
            </button>
          )}
          {tool.output && (
            <button
              className="text-button"
              onClick={() => void attempt(() => api.copyText(tool.output))}
            >
              {tr("Копировать вывод")}
            </button>
          )}
        </div>
      </div>
      <div className="tool-input">
        <pre tabIndex={0}>{tool.command ?? tool.input}</pre>
      </div>
      {tool.cwd && (
        <div className="tool-meta">
          {tr("Рабочая папка: ")}
          {tool.cwd}
        </div>
      )}
      <div className="tool-output">
        <LogViewer text={tool.output} scope={tool.id} />
        {tool.outputTruncated && (
          <small>{tr("OpenCode сохранил только часть вывода.")}</small>
        )}
      </div>
      {tool.category === "edit" &&
        status === "completed" &&
        !tool.changes?.length && (
          <div className="tool-meta">
            {tr("OpenCode не сохранил текстовый diff.")}
          </div>
        )}
      {tool.images.length > 0 && <ImageGallery images={tool.images} />}
      {tool.exit !== undefined && (
        <div className="tool-meta">{trf`Код завершения ${tool.exit}`}</div>
      )}
      {tool.childSessionId && (
        <div className="subagent-card">
          <span className="subagent-status">
            {child?.running ? (
              <>
                <LoaderCircle size={12} className="spin" />
                {tr("Субагент работает")}
              </>
            ) : child?.outcome === "succeeded" ? (
              <>
                <Check size={12} />
                {tr("Субагент завершил работу")}
              </>
            ) : child?.outcome === "failed" ? (
              tr("Субагент завершился с ошибкой")
            ) : child?.outcome === "interrupted" ? (
              tr("Субагент остановлен")
            ) : (
              tr("Статус субагента уточняется при открытии")
            )}
          </span>
          {child && (
            <small>
              {child.title}
              {child.busy && child.idle
                ? ` · ${duration(child.idle - child.busy)}`
                : ""}
            </small>
          )}
          <button
            className="text-button"
            onClick={() =>
              void attempt(async () => {
                const snapshot = await api.openSession(tool.childSessionId!);
                useApp.getState().set({
                  snapshot,
                  preferences: {
                    ...useApp.getState().preferences,
                    sessionId: snapshot.session.id,
                    projectId: snapshot.session.projectId,
                  },
                });
              })
            }
          >
            <GitBranch size={12} />
            {tr("Открыть сессию субагента")}
          </button>
        </div>
      )}
    </div>
  );
  if (status === "completed" && tool.changes?.length === 1)
    return (
      <div className="tool-item" data-status={status}>
        <FileEditDiffItem
          diffs={tool.changes}
          scope={tool.id}
          result={result}
        />
      </div>
    );

  return (
    <div className="tool-item" data-status={status}>
      <button className="tool-summary" onClick={toggle} aria-expanded={open}>
        <Icon size={14} aria-hidden="true" />
        <span className="tool-label">
          <strong className={busy ? "activity-shimmer" : undefined}>
            {toolTitle(tool, busy)}
          </strong>
          {subject && (
            <span
              className={tool.path ? "activity-path" : undefined}
              title={tool.path?.full ?? subject}
            >
              {subject}
            </span>
          )}
        </span>
        <span className="tool-state">{statusLabel}</span>
        {tool.started !== undefined && tool.ended !== undefined && (
          <small className="tool-duration">
            {duration(tool.ended - tool.started)}
          </small>
        )}
        <ChevronRight
          size={12}
          className={open ? "rotated" : ""}
          aria-hidden="true"
        />
      </button>
      {open &&
        (tool.changes?.length ? (
          <>
            <FileEditDiffItem diffs={tool.changes} scope={tool.id} />
            <ActivityResult scope={tool.id}>{result}</ActivityResult>
          </>
        ) : (
          result
        ))}
    </div>
  );
});
function ActivityResult({
  scope,
  children,
}: {
  scope: string;
  children: ReactNode;
}) {
  const { open, toggle } = useActivityDisclosure(`result:${scope}`);
  return (
    <div className="activity-result">
      <button
        className="text-button activity-disclosure"
        aria-expanded={open}
        onClick={toggle}
      >
        {open
          ? tr("Свернуть результат инструмента")
          : tr("Полный результат инструмента")}
      </button>
      {open && children}
    </div>
  );
}
const ActionGroupBlock = memo(function ActionGroupBlock({
  row,
  waiting,
}: {
  row: Extract<TimelineRow, { type: "actions" }>;
  waiting: ReadonlySet<string>;
}) {
  useLanguage();
  const { hidden, ready } = useContext(ActivityDisplay)!;
  const { open, toggle } = useActivityDisclosure(`stage:${row.id}`);
  const groups = useMemo(() => activityGroups(row.tools), [row.tools]);
  const counts = {
    completed: 0,
    error: 0,
    interrupted: 0,
    unknown: 0,
    running: 0,
  };
  for (const tool of row.tools) counts[toolState(tool)]++;
  const results = [
    counts.completed && trf`Завершено: ${counts.completed}`,
    counts.error && trf`Ошибки: ${counts.error}`,
    counts.interrupted && trf`Остановлено: ${counts.interrupted}`,
    counts.unknown && trf`Без результата: ${counts.unknown}`,
    counts.running && trf`В работе: ${counts.running}`,
  ].filter(Boolean);
  return (
    <div className="action-group">
      <button
        className="activity-stage-toggle activity-disclosure"
        aria-expanded={open}
        disabled={!ready}
        onClick={toggle}
      >
        <Wrench size={14} aria-hidden="true" />
        <span>{trf`Действия: ${row.tools.length}`}</span>
        <span className="activity-results">{results.join(" · ")}</span>
        <ChevronRight
          size={12}
          className={open ? "rotated" : ""}
          aria-hidden="true"
        />
      </button>
      {open
        ? groups.map((group) => (
            <ActivityCategory
              key={group.id}
              group={group}
              hidden={hidden}
              waiting={waiting}
            />
          ))
        : row.tools
            .filter((tool) => needsAttention(tool, waiting))
            .map((tool) => (
              <ToolBlock
                key={tool.id}
                tool={tool}
                waiting={waiting.has(tool.id)}
              />
            ))}
    </div>
  );
});
function needsAttention(tool: ToolItem, waiting: ReadonlySet<string>) {
  const state = toolState(tool);
  return state === "error" || state === "running" || waiting.has(tool.id);
}

function ActivityCategory({
  group,
  hidden,
  waiting,
}: {
  group: ReturnType<typeof activityGroups>[number];
  hidden: boolean;
  waiting: ReadonlySet<string>;
}) {
  const { open, toggle } = useActivityDisclosure(`group:${group.id}`);
  const display = useContext(ActivityDisplay)!;
  const pageSize = 36;
  const pageId = (limit: number) => `more:${group.id}:${limit}`;
  let limit = pageSize;
  while (limit < group.tools.length && display.open.has(pageId(limit)))
    limit += pageSize;
  const visible = hidden
    ? group.tools.filter((tool) => toolState(tool) !== "completed")
    : group.tools;
  if (!visible.length) return null;
  if (visible.length === 1) {
    const tool = visible[0];
    return <ToolBlock tool={tool} waiting={waiting.has(tool.id)} />;
  }
  const Icon = groupIcons[group.kind];
  return (
    <div className="activity-category" data-kind={group.kind}>
      <button
        className="activity-category-toggle activity-disclosure"
        aria-expanded={open}
        onClick={toggle}
      >
        <Icon size={14} aria-hidden="true" />
        <span>
          {groupTitle(group.kind)} · {visible.length}
        </span>
        <ChevronRight
          size={12}
          className={open ? "rotated" : ""}
          aria-hidden="true"
        />
      </button>
      {visible
        .filter(
          (tool, index) =>
            (open && index < limit) || needsAttention(tool, waiting),
        )
        .map((tool) => (
          <ToolBlock key={tool.id} tool={tool} waiting={waiting.has(tool.id)} />
        ))}
      {open &&
        visible.slice(limit).some((tool) => !needsAttention(tool, waiting)) && (
          <button
            className="text-button activity-disclosure"
            onClick={() => display.toggle(pageId(limit))}
          >
            {tr("Показать ещё действия")}
          </button>
        )}
    </div>
  );
}
function PermissionCard({ permission }: { permission: Permission }) {
  useLanguage();

  const [busy, setBusy] = useState(false);
  const reply = (decision: "once" | "reject") => {
    setBusy(true);
    void attempt(() =>
      api.permission(permission.sessionId, permission.id, decision),
    ).finally(() => setBusy(false));
  };
  return (
    <div className="permission-card timeline-permission" data-status="waiting">
      <div className="permission-heading">
        <Shield size={16} />
        <strong>{tr("Требуется разрешение")}</strong>
        <span className="badge">{permission.action}</span>
      </div>
      <pre>{permission.resources.join("\n")}</pre>
      <div className="permission-actions">
        <button
          className="secondary"
          disabled={busy}
          onClick={() => reply("reject")}
        >
          {tr("Отклонить")}
        </button>
        <button
          className="primary"
          disabled={busy}
          onClick={() => reply("once")}
        >
          {tr("Разрешить один раз")}
        </button>
      </div>
    </div>
  );
}
function FormCard({ form }: { form: AgentForm }) {
  useLanguage();

  const [values, setValues] = useState<Answers>(() => defaults(form.fields));
  const [busy, setBusy] = useState(false);
  const reply = (answer: Answers | null) => {
    setBusy(true);
    void attempt(() => api.replyForm(form.sessionId, form.id, answer)).finally(
      () => setBusy(false),
    );
  };
  return (
    <form
      className="permission-card agent-form"
      onSubmit={(e) => {
        e.preventDefault();
        reply(values);
      }}
    >
      <strong>{form.title}</strong>
      <Fields fields={form.fields} values={values} change={setValues} />
      <div className="permission-actions">
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => reply(null)}
        >
          {tr("Пропустить")}
        </button>
        <button className="primary" disabled={busy}>
          {tr("Ответить")}
        </button>
      </div>
    </form>
  );
}
function FileChangePreview({
  file,
  id,
  full,
  result,
}: {
  file: ActionFileDiff;
  id: string;
  full: () => void;
  result?: ReactNode;
}) {
  useLanguage();

  const { open, toggle } = useActivityDisclosure(id);
  const title =
    file.status === "added"
      ? tr("Добавлен")
      : file.status === "deleted"
        ? tr("Удалён")
        : file.status === "renamed"
          ? tr("Переименован")
          : file.status === "written"
            ? tr("Записан")
            : tr("Изменён");
  const binary = /^(?:Binary files .* differ|GIT binary patch)\r?$/m.test(
    file.patch,
  );
  const patch = !binary && file.patch.trim() ? file.patch : "";
  return (
    <div className="file-change">
      <div className="file-change-header">
        <button
          className="file-change-toggle"
          aria-expanded={open}
          onClick={toggle}
        >
          <FileCode2 size={13} aria-hidden="true" />
          <span className="activity-path" title={file.fullFile ?? file.file}>
            {title} <code>{file.displayFile ?? file.file}</code>
          </span>
          {!binary && file.additions !== undefined && (
            <b className="green">+{file.additions}</b>
          )}
          {!binary && file.deletions !== undefined && (
            <b className="red">−{file.deletions}</b>
          )}
          <ChevronRight
            size={12}
            className={open ? "rotated" : ""}
            aria-hidden="true"
          />
        </button>
      </div>
      {open && (
        <div className="file-change-body">
          {!!file.previousFile && (
            <p>{trf`Прежний путь: ${file.previousFile}`}</p>
          )}
          {patch ? (
            <>
              <DiffViewer patch={patch} inline />
              <button className="text-button" onClick={full}>
                <Maximize2 size={12} aria-hidden="true" />
                {trf`Открыть diff ${file.file}`}
              </button>
            </>
          ) : (
            <p>
              {binary
                ? tr("Двоичный файл · текстовый diff недоступен")
                : tr("OpenCode не сохранил текстовый diff.")}
            </p>
          )}
          {file.more && <p>{tr("OpenCode вернул только часть изменений.")}</p>}
          {result && <ActivityResult scope={id}>{result}</ActivityResult>}
        </div>
      )}
    </div>
  );
}
function FileEditDiffItem({
  diffs,
  scope,
  task = false,
  result,
}: {
  diffs: ActionFileDiff[];
  scope: string;
  task?: boolean;
  result?: ReactNode;
}) {
  useLanguage();

  const [current, setCurrent] = useState<ActionFileDiff>();
  const { open: all, toggle: toggleAll } = useActivityDisclosure(
    `files:${scope}`,
  );
  const { open: taskOpen, toggle: toggleTask } = useActivityDisclosure(
    `task-diff:${scope}`,
  );
  const showFiles = !task || taskOpen;
  return (
    <>
      <div
        className={task ? "file-edit-card" : "action-files"}
        aria-label={task ? tr("Изменения файлов всей задачи") : undefined}
      >
        {task && (
          <button
            className="activity-stage-toggle activity-disclosure task-files-toggle"
            aria-expanded={taskOpen}
            onClick={toggleTask}
          >
            <FileCode2 size={14} aria-hidden="true" />
            <span>{tr("Изменения файлов всей задачи")}</span>
            <span className="activity-results">{diffs.length}</span>
            <ChevronRight
              size={12}
              className={taskOpen ? "rotated" : ""}
              aria-hidden="true"
            />
          </button>
        )}
        {showFiles &&
          (all ? diffs : diffs.slice(0, 6)).map((file, index) => (
            <FileChangePreview
              key={`${file.file}:${index}`}
              id={`file:${scope}:${index}`}
              file={file}
              full={() => setCurrent(file)}
              result={result}
            />
          ))}
        {showFiles && diffs.length > 6 && (
          <button
            className="text-button"
            aria-expanded={all}
            onClick={toggleAll}
          >
            {all
              ? tr("Свернуть список файлов")
              : trf`Показать все файлы (${diffs.length})`}
          </button>
        )}
      </div>
      {current && (
        <Modal title={current.file} wide close={() => setCurrent(undefined)}>
          <DiffViewer patch={current.patch} />
        </Modal>
      )}
    </>
  );
}
function UserMessage({
  row,
  canEdit,
}: {
  row: Extract<TimelineRow, { type: "user" }>;
  canEdit: boolean;
}) {
  useLanguage();

  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(row.text);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  const editor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!editing || !editor.current) return;
    let frame = 0;
    const reveal = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() =>
        editor.current?.scrollIntoView({ block: "nearest" }),
      );
    };
    const observer = new ResizeObserver(reveal);
    observer.observe(editor.current);
    const timeline = editor.current.closest(".timeline-scroll");
    if (timeline) observer.observe(timeline);
    reveal();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [editing]);
  const ready = useApp(
    (state) => state.engine.state === "ready" && !!state.preferences.model,
  );
  async function submit() {
    const { snapshot, preferences } = useApp.getState();
    if (
      !snapshot ||
      !preferences.model ||
      !value.trim() ||
      saving ||
      !ready ||
      !canEdit
    )
      return;
    setSaving(true);
    try {
      const result = await api.editLastMessage(
        snapshot.session.id,
        row.id,
        value,
        preferences.model,
        preferences.mode,
      );
      if (!result.sent) {
        if (useApp.getState().preferences.sessionId === snapshot.session.id)
          window.dispatchEvent(
            new CustomEvent("forge:prompt", { detail: value }),
          );
        report(result.error);
      }
      setEditing(false);
    } catch (error) {
      report(error);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="user-row">
      <div className={`user-message-wrap ${editing ? "editing" : ""}`}>
        {!!row.attachments?.length && (
          <div className="history-attachments">
            {row.attachments.map((file, i) => (
              <span key={i} title={file.mime}>
                <FileCode2 size={13} />
                {file.name}
              </span>
            ))}
          </div>
        )}
        {row.images && row.images.length > 0 && (
          <div className="user-attachments">
            <ImageGallery images={row.images} />
          </div>
        )}
        {editing ? (
          <div className="user-edit" ref={editor}>
            <textarea
              autoFocus
              aria-label={tr("Изменить сообщение")}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              disabled={saving}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  if (!saving) setEditing(false);
                }
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            <div className="user-edit-actions">
              <button disabled={saving} onClick={() => setEditing(false)}>
                {tr("Отмена")}
              </button>
              <button
                className="primary"
                disabled={saving || !value.trim() || !ready || !canEdit}
                onClick={() => void submit()}
              >
                {saving ? tr("Отправка…") : tr("Отправить")}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="user-message">
              <Markdown text={row.text} />
            </div>
            <div className="user-message-meta">
              <time
                dateTime={new Date(row.at).toISOString()}
                title={new Date(row.at).toLocaleString()}
              >
                {new Date(row.at).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
              <div className="user-message-actions">
                <IconButton
                  label={
                    copied ? tr("Скопировано") : tr("Копировать сообщение")
                  }
                  onClick={() =>
                    void attempt(async () => {
                      await api.copyText(row.text);
                      setCopied(true);
                      clearTimeout(copyTimer.current);
                      copyTimer.current = setTimeout(
                        () => setCopied(false),
                        1400,
                      );
                    })
                  }
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                </IconButton>
                {canEdit && (
                  <IconButton
                    label={tr("Изменить последнее сообщение")}
                    onClick={() => {
                      setValue(row.text);
                      setEditing(true);
                    }}
                  >
                    <Pencil size={14} />
                  </IconButton>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
function RunSummary({
  row,
  now,
}: {
  row: Extract<TimelineRow, { type: "run" }>;
  now?: number;
}) {
  useLanguage();

  const [open, setOpen] = useState(expanded.get(row.id) ?? false);
  const elapsed =
    row.status === "running" && row.started !== undefined && now !== undefined
      ? now - row.started
      : row.duration;
  if (row.status === "running")
    return (
      <div className="activity-stage" role="status">
        <Clock3 size={12} aria-hidden="true" />
        <span>{row.text}</span>
        {elapsed !== undefined && <small>· {duration(elapsed)}</small>}
      </div>
    );
  return (
    <div
      className={`run-summary ${row.status === "failed" ? "run-failed" : ""}`}
      data-status={row.status}
    >
      <button
        className="run-disclosure"
        disabled={!row.details.length}
        aria-expanded={row.details.length ? open : undefined}
        onClick={() => {
          expanded.set(row.id, !open);
          setOpen(!open);
        }}
      >
        {row.status === "succeeded" ? (
          <Check size={12} />
        ) : row.status === "interrupted" ? (
          <Square size={10} />
        ) : row.status === "failed" ? (
          <CircleAlert size={12} />
        ) : (
          <Clock3 size={12} />
        )}
        <span>{row.text}</span>
        {elapsed !== undefined && <small>· {duration(elapsed)}</small>}
        {row.details.length > 0 && (
          <ChevronRight size={12} className={open ? "rotated" : ""} />
        )}
      </button>
      {open && row.details.length > 0 && (
        <div className="run-details" aria-label={tr("Детали запуска")}>
          {row.details.map((detail) => (
            <div
              key={detail.id}
              className={`run-detail ${detail.status === "error" ? "red" : ""}`}
            >
              {detail.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
function FailureNotice({ text }: { text: string }) {
  useLanguage();

  const { title, hint } = explainError(text);
  return (
    <div className="system-event red failure-notice">
      <CircleAlert size={13} />
      <div>
        <strong>{tr(title)}</strong>
        <p>{text.length > 700 ? `${text.slice(0, 700)}…` : text}</p>
        <small>{tr(hint)}</small>
      </div>
    </div>
  );
}
const Row = memo(function Row({
  row,
  canEdit,
  runNow,
  waiting,
}: {
  row: TimelineRow;
  canEdit: boolean;
  runNow?: number;
  waiting: ReadonlySet<string>;
}) {
  useLanguage();

  if (row.type === "actions")
    return <ActionGroupBlock row={row} waiting={waiting} />;
  if (row.type === "user") return <UserMessage row={row} canEdit={canEdit} />;
  if (row.type === "run") return <RunSummary row={row} now={runNow} />;
  if (row.type === "text")
    return (
      <div className="assistant-message">
        <Markdown text={row.text} />
      </div>
    );
  if (row.status === "error" || row.status === "failed")
    return <FailureNotice text={row.text} />;
  return (
    <div
      className={`system-event ${row.status === "error" || row.status === "failed" ? "red" : ""}`}
    >
      {row.status === "error" || row.status === "failed" ? (
        <CircleAlert size={13} />
      ) : row.duration !== undefined ? (
        <Clock3 size={13} />
      ) : row.status === "succeeded" ? (
        <Check size={13} />
      ) : null}
      <span>
        {row.text}
        {row.duration !== undefined ? ` · ${duration(row.duration)}` : ""}
      </span>
    </div>
  );
});
export function Timeline({ snapshot }: { snapshot: Snapshot }) {
  return <SessionTimeline key={snapshot.session.id} snapshot={snapshot} />;
}

function SessionTimeline({ snapshot }: { snapshot: Snapshot }) {
  useLanguage();

  const id = snapshot.session.id;
  const display = useActivityDisplay(id);
  const rows = useMemo(
    () => activityRows(snapshot.rows, display.hidden),
    [snapshot.rows, display.hidden],
  );
  const railSnapshot = useMemo(() => ({ ...snapshot, rows }), [snapshot, rows]);
  const hiddenRef = useRef(display.hidden);
  hiddenRef.current = display.hidden;
  const hasActivity =
    snapshot.diffs.length ||
    snapshot.rows.some((row) => row.type === "actions");
  const searchTarget = useApp((s) => s.searchTarget);
  const scroll = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [restored, setRestored] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [now, setNow] = useState(Date.now());
  const waiting = useMemo(
    () =>
      new Set(
        snapshot.permissions.flatMap((request) =>
          request.toolId ? [request.toolId] : [],
        ),
      ),
    [snapshot.permissions],
  );
  const navigating = useRef(false);
  const restoreDelta = useRef(0);
  const positionAnchor = useRef<
    { messageId: string; delta: number } | undefined
  >(undefined);
  const [restoreTarget, setRestoreTarget] = useState<string>();
  const scrollTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const disclosureFrame = useRef(0);
  const count =
    rows.length +
    snapshot.permissions.length +
    snapshot.forms.length +
    (snapshot.diffs.length && !display.hidden ? 1 : 0);
  const virtual = useVirtualizer({
    count,
    getScrollElement: () => scroll.current,
    estimateSize: (i) => {
      const row = rows[i];
      if (!row) return 180;
      if (row.type === "actions")
        return (
          40 +
          row.tools.filter((tool) => needsAttention(tool, waiting)).length * 29
        );
      return row.type === "text" || row.type === "user"
        ? Math.min(900, Math.ceil(row.text.length / 85) * 23 + 32)
        : 48;
    },
    getItemKey: (i) =>
      rows[i]?.id ??
      snapshot.permissions[i - rows.length]?.id ??
      snapshot.forms[i - rows.length - snapshot.permissions.length]?.id ??
      i,
    overscan: 8,
  });
  // Resizing a visible disclosure keeps its header in place. Rows fully above
  // the viewport still compensate for height changes during virtual measurement.
  virtual.shouldAdjustScrollPositionOnItemSizeChange = (
    item,
    _delta,
    instance,
  ) => !disclosureFrame.current && item.end <= (instance.scrollOffset ?? 0);
  const cancelDisclosureAnchor = () => {
    cancelAnimationFrame(disclosureFrame.current);
    disclosureFrame.current = 0;
  };
  function anchorDisclosure(target: EventTarget) {
    if (!(target instanceof HTMLElement || target instanceof SVGElement))
      return;
    const control = target.closest<HTMLElement>(
      [
        ".tool-summary",
        ".tool-log-toggle",
        ".file-change-toggle",
        ".activity-disclosure",
        ".action-files > button[aria-expanded]",
        ".file-edit-card > button[aria-expanded]",
      ].join(","),
    );
    const scroller = scroll.current;
    if (!control || !scroller) return;
    cancelDisclosureAnchor();
    const top = control.getBoundingClientRect().top;
    let frames = 0;
    const restore = () => {
      if (!control.isConnected || ++frames > 8) {
        disclosureFrame.current = 0;
        return;
      }
      const delta = control.getBoundingClientRect().top - top;
      if (Math.abs(delta) > 0.5) scroller.scrollTop += delta;
      disclosureFrame.current = requestAnimationFrame(restore);
    };
    disclosureFrame.current = requestAnimationFrame(restore);
  }
  useEffect(() => {
    const target =
      searchTarget?.sessionId === id ? searchTarget.messageId : restoreTarget;
    if (!target || !restored) return;
    let active = true,
      frame = 0;
    navigating.current = true;
    following.current = false;
    const cancel = () => {
      active = false;
      navigating.current = false;
      cancelAnimationFrame(frame);
    };
    const element = scroll.current;
    element?.addEventListener("wheel", cancel, { passive: true });
    element?.addEventListener("touchstart", cancel, { passive: true });
    element?.addEventListener("pointerdown", cancel);
    const keyboard = (e: KeyboardEvent) => {
      if (
        ["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"].includes(
          e.key,
        )
      )
        cancel();
    };
    element?.addEventListener("keydown", keyboard);
    void attempt(async () => {
      let current = useApp.getState().snapshot ?? snapshot;
      const matches = (row: TimelineRow) =>
        row.id === target || row.id.startsWith(target + ":");
      const seen = new Set<string>();
      while (!current.rows.some(matches) && current.olderCursor && active) {
        if (seen.has(current.olderCursor)) break;
        seen.add(current.olderCursor);
        current = await api.olderMessages(id, current.olderCursor);
      }
      if (!active || useApp.getState().snapshot?.session.id !== id) return;
      const visible = activityRows(current.rows, hiddenRef.current);
      const index = visible.findIndex(matches);
      if (index < 0 && !current.rows.some(matches))
        throw new Error(
          tr(
            "Сообщение не найдено в доступной истории. Загрузите предыдущие сообщения.",
          ),
        );
      if (index < 0) {
        setRestoreTarget(undefined);
        return;
      }
      useApp.getState().set({ snapshot: current });
      // Scroll using the virtual index, then correct against measured DOM geometry.
      // A few stable frames let dynamic row measurements settle without smooth scrolling.
      let attempts = 0,
        stable = 0;
      const settle = () => {
        if (!active || !scroll.current) return;
        const row = [
          ...scroll.current.querySelectorAll<HTMLElement>("[data-row-id]"),
        ].find((el) => el.dataset.rowId === visible[index].id);
        if (row) {
          const desiredTop =
            searchTarget?.sessionId === id ? 12 : -restoreDelta.current;
          const delta =
            row.getBoundingClientRect().top -
            scroll.current.getBoundingClientRect().top -
            desiredTop;
          scroll.current.scrollTop += delta;
          stable = Math.abs(delta) < 1 ? stable + 1 : 0;
        } else virtual.scrollToIndex(index, { align: "start" });
        if (++attempts < 40 && stable < 4)
          frame = requestAnimationFrame(settle);
        else {
          navigating.current = false;
          setRestoreTarget(undefined);
        }
      };
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(settle);
      });
    }).finally(() => {
      if (!active || !frame) navigating.current = false;
    });
    return () => {
      cancel();
      element?.removeEventListener("wheel", cancel);
      element?.removeEventListener("touchstart", cancel);
      element?.removeEventListener("pointerdown", cancel);
      element?.removeEventListener("keydown", keyboard);
    };
  }, [id, searchTarget, restored, restoreTarget]);
  const lastUserId = [...snapshot.rows]
    .reverse()
    .find((row) => row.type === "user")?.id;
  useEffect(() => {
    let lastEscape = 0;
    let stopping = false;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.repeat ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      if (document.querySelector('[role="dialog"]')) {
        lastEscape = 0;
        return;
      }
      const now = Date.now();
      if (
        now - lastEscape < 600 &&
        useApp.getState().snapshot?.session.running &&
        !stopping
      ) {
        event.preventDefault();
        lastEscape = 0;
        stopping = true;
        void attempt(() => api.stop(id)).finally(() => {
          stopping = false;
        });
      } else lastEscape = now;
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [id]);
  useEffect(() => {
    if (!display.ready) return;
    let active = true;
    setRestored(false);
    void api.loadDraft(`scroll:${id}`).then((saved) => {
      if (!active) return;
      let persisted: { offset?: number; messageId?: string; delta?: number } =
        {};
      try {
        persisted = saved?.startsWith("{")
          ? JSON.parse(saved)
          : { offset: saved ? Number(saved) : undefined };
      } catch {
        /* Older invalid drafts fall back to the end. */
      }
      const offset = offsets.get(id) ?? persisted.offset;
      positionAnchor.current = persisted.messageId
        ? { messageId: persisted.messageId, delta: persisted.delta ?? 0 }
        : undefined;
      restoreDelta.current = persisted.delta ?? 0;
      setRestoreTarget(persisted.messageId);
      requestAnimationFrame(() => {
        if (offset !== undefined && Number.isFinite(offset)) {
          virtual.scrollToOffset(offset);
          following.current = false;
          setAtBottom(false);
        } else {
          virtual.scrollToIndex(Math.max(0, count - 1), { align: "end" });
          following.current = true;
        }
        setRestored(true);
      });
    });
    return () => {
      active = false;
      cancelDisclosureAnchor();
      clearTimeout(scrollTimer.current);
      if (offsets.has(id))
        void api.saveDraft(
          `scroll:${id}`,
          JSON.stringify({
            offset: offsets.get(id),
            ...positionAnchor.current,
          }),
        );
    };
  }, [id, display.ready]);
  useEffect(() => {
    if (!snapshot.session.running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [snapshot.session.running]);
  useLayoutEffect(() => {
    if (restored && following.current && count)
      virtual.scrollToIndex(count - 1, { align: "end" });
  }, [snapshot, restored, count]);
  function toggleCompleted() {
    const nextHidden = !display.hidden;
    const element = scroll.current;
    if (!following.current && element) {
      const next = activityRows(snapshot.rows, nextHidden);
      const keptIds = new Set(next.map((row) => row.id));
      const top = element.getBoundingClientRect().top;
      const visible = [
        ...element.querySelectorAll<HTMLElement>("[data-row-id]"),
      ].find(
        (row) =>
          row.getBoundingClientRect().bottom > top &&
          row.dataset.rowId &&
          keptIds.has(row.dataset.rowId),
      );
      if (visible?.dataset.rowId) {
        restoreDelta.current = top - visible.getBoundingClientRect().top;
        setRestoreTarget(visible.dataset.rowId);
      }
    }
    display.setHidden(nextHidden);
  }
  return (
    <ActivityDisplay.Provider value={display}>
      <div className="timeline-area">
        <ConversationRail
          snapshot={railSnapshot}
          visibleIndex={virtual.range?.startIndex ?? 0}
        />
        {!!hasActivity && (
          <div className="activity-controls">
            <button
              className="text-button"
              disabled={!display.ready}
              onClick={toggleCompleted}
            >
              {display.hidden
                ? tr("Показать действия")
                : tr("Скрыть завершённые действия")}
            </button>
          </div>
        )}
        <div
          className="timeline-scroll"
          ref={scroll}
          onClickCapture={(event) => anchorDisclosure(event.target)}
          onPointerDownCapture={cancelDisclosureAnchor}
          onWheelCapture={cancelDisclosureAnchor}
          onTouchStartCapture={cancelDisclosureAnchor}
          onScroll={() => {
            const el = scroll.current;
            if (!el) return;
            const bottom =
              el.scrollHeight - el.scrollTop - el.clientHeight < 100;
            if (!navigating.current) following.current = bottom;
            setAtBottom(bottom);
            offsets.set(id, el.scrollTop);
            clearTimeout(scrollTimer.current);
            const viewportTop = el.getBoundingClientRect().top;
            const visible = [
              ...el.querySelectorAll<HTMLElement>("[data-row-id]"),
            ].find((row) => row.getBoundingClientRect().bottom > viewportTop);
            if (visible?.dataset.rowId)
              positionAnchor.current = {
                messageId: visible.dataset.rowId,
                delta: viewportTop - visible.getBoundingClientRect().top,
              };
            scrollTimer.current = setTimeout(
              () =>
                void api.saveDraft(
                  `scroll:${id}`,
                  JSON.stringify({
                    offset: el.scrollTop,
                    messageId: positionAnchor.current?.messageId,
                    delta: positionAnchor.current?.delta,
                  }),
                ),
              400,
            );
          }}
        >
          <div className="timeline-column">
            {snapshot.olderCursor && (
              <button
                className="load-older"
                disabled={loadingOlder}
                onClick={() => {
                  setLoadingOlder(true);
                  const topId = rows[0]?.id;
                  void attempt(async () => {
                    const next = await api.olderMessages(
                      id,
                      snapshot.olderCursor!,
                    );
                    if (useApp.getState().preferences.sessionId !== id) return;
                    following.current = false;
                    useApp.getState().set({ snapshot: next });
                    requestAnimationFrame(() => {
                      const index = activityRows(
                        next.rows,
                        display.hidden,
                      ).findIndex((r) => r.id === topId);
                      if (index >= 0) virtual.scrollToIndex(index);
                    });
                  }).finally(() => setLoadingOlder(false));
                }}
              >
                {loadingOlder
                  ? tr("Загрузка…")
                  : tr("Загрузить предыдущие сообщения")}
              </button>
            )}
            {!count && (
              <div className="session-empty">
                <span>{tr("Новая задача")}</span>
                <p>{tr("Опишите результат, который хотите получить.")}</p>
              </div>
            )}
            <div
              className="virtual-timeline"
              style={{ height: virtual.getTotalSize() }}
            >
              {virtual.getVirtualItems().map((item) => (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtual.measureElement}
                  data-row-id={rows[item.index]?.id}
                  className={`timeline-item ${rows[item.index]?.type === "user" ? "timeline-item-user" : ""} ${searchTarget?.sessionId === id && (rows[item.index]?.id === searchTarget.messageId || rows[item.index]?.id.startsWith(`${searchTarget.messageId}:`)) ? "search-hit" : ""}`}
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  {item.index < rows.length ? (
                    <Row
                      row={rows[item.index]}
                      waiting={waiting}
                      runNow={rows[item.index].type === "run" ? now : undefined}
                      canEdit={
                        !snapshot.session.running &&
                        !snapshot.queued.length &&
                        rows[item.index].id === lastUserId
                      }
                    />
                  ) : item.index < rows.length + snapshot.permissions.length ? (
                    <PermissionCard
                      permission={
                        snapshot.permissions[item.index - rows.length]
                      }
                    />
                  ) : item.index <
                    rows.length +
                      snapshot.permissions.length +
                      snapshot.forms.length ? (
                    <FormCard
                      form={
                        snapshot.forms[
                          item.index - rows.length - snapshot.permissions.length
                        ]
                      }
                    />
                  ) : (
                    <FileEditDiffItem
                      diffs={snapshot.diffs}
                      scope={`task:${id}`}
                      task
                    />
                  )}
                </div>
              ))}
            </div>
            {snapshot.session.running &&
              !snapshot.rows.some(
                (row) => row.type === "run" && row.status === "running",
              ) && (
                <div className="session-timer">
                  <LoaderCircle size={13} className="spin" />
                  <span>
                    {tr("OpenCode выполняет задачу")}
                    {snapshot.session.busy
                      ? ` · ${duration(now - snapshot.session.busy)}`
                      : ""}
                  </span>
                </div>
              )}
          </div>
        </div>
        {!atBottom && count > 0 && (
          <button
            className="jump-bottom"
            aria-label={tr("К последнему сообщению")}
            onClick={() => {
              following.current = true;
              setAtBottom(true);
              virtual.scrollToIndex(count - 1, { align: "end" });
            }}
          >
            <ArrowDown size={17} />
          </button>
        )}
      </div>
    </ActivityDisplay.Provider>
  );
}
