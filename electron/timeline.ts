import type {
  SessionMessageInfo,
  SessionMessageAssistantTool,
} from "@opencode/client";
import type {
  ImageRef,
  ModelRef,
  RunDetail,
  TimelineRow,
  ToolItem,
} from "../shared/types";
import { formatToolOutput, safeToolData } from "../shared/tool-output";
import { actionDiffs } from "./action-diffs";
import { activityPath } from "./activity-path";

export const interrupted = (error: { type: string; message: string }) =>
  /interrupt|abort|cancel/i.test(error.type) ||
  (!/^provider[.:]/i.test(error.type) &&
    /^(?:step interrupted|request aborted|request cancel(?:led|ed))\.?$/i.test(
      error.message.trim(),
    ));

export function toolCategory(name: string): ToolItem["category"] {
  if (["shell", "bash"].includes(name)) return "shell";
  if (["read", "glob", "grep", "list", "lsp"].includes(name)) return "read";
  if (["edit", "write", "patch", "apply_patch", "multiedit"].includes(name))
    return "edit";
  if (["webfetch", "websearch"].includes(name)) return "web";
  return "other";
}
const pretty = (value: unknown) =>
  typeof value === "string"
    ? value
    : JSON.stringify(safeToolData(value), null, 2);
export function normalizeTimeline(
  messages: SessionMessageInfo[],
  image: (uri: string, name?: string) => string | undefined,
  redact: (text: string) => string = (s) => s,
  running = false,
  directory?: string,
): TimelineRow[] {
  directory =
    messages.find((message) => message.type === "location-switched")?.previous
      ?.location.directory ?? directory;
  const rows: TimelineRow[] = [];
  let actionAgent: string | undefined;
  let actionGroup: Extract<TimelineRow, { type: "actions" }> | undefined;
  const pushTool = (tool: ToolItem, at: number, agent?: string) => {
    if (run && ["running", "streaming"].includes(tool.status))
      run.stage =
        tool.category === "shell"
          ? "Выполняет команду"
          : tool.category === "read"
            ? "Читает файлы"
            : tool.category === "edit"
              ? "Изменяет файлы"
              : tool.childSessionId
                ? "Работает с субагентом"
                : "Выполняет инструмент";
    if (actionGroup && rows.at(-1) === actionGroup && actionAgent === agent)
      actionGroup.tools.push(tool);
    else {
      actionAgent = agent;
      actionGroup = {
        id: `actions:${tool.id}`,
        type: "actions",
        tools: [tool],
        at,
      };
      rows.push(actionGroup);
    }
  };
  const convertTool = (tool: SessionMessageAssistantTool): ToolItem => {
    const state = tool.state;
    const input = state.input;
    const obj = typeof input === "object" ? input : {};
    const metadata = "metadata" in state ? (state.metadata ?? {}) : {};
    const content = "content" in state ? (state.content ?? []) : [];
    const images: ImageRef[] = [];
    for (const item of content)
      if (
        item.type === "file" &&
        /^image\/(png|jpeg|webp|gif|avif|bmp)$/.test(item.mime)
      ) {
        const url = image(item.uri, item.name ?? undefined);
        if (url) images.push({ url, name: item.name ?? "Изображение" });
      }
    const category =
      tool.name === "read" && state.status === "completed" && images.length
        ? "image"
        : toolCategory(tool.name);
    const title =
      obj.description ??
      obj.command ??
      obj.filePath ??
      obj.path ??
      obj.pattern ??
      obj.url ??
      obj.query ??
      tool.name;
    const file = obj.filePath ?? obj.path;
    const location =
      typeof file === "string" &&
      file &&
      ["read", "image", "edit"].includes(category)
        ? activityPath(file, directory)
        : undefined;
    return {
      id: tool.id,
      name: tool.name,
      category,
      title: redact(String(title)),
      status: state.status,
      command:
        category === "shell" && typeof obj.command === "string"
          ? redact(obj.command)
          : undefined,
      outputTruncated: metadata.truncated === true || undefined,
      changes:
        category === "edit" && state.status === "completed"
          ? actionDiffs(tool.name, obj, metadata, redact, directory)
          : undefined,
      path: location
        ? { full: redact(location.full), display: redact(location.display) }
        : undefined,
      input: redact(pretty(input) ?? ""),
      output: redact(
        formatToolOutput(
          content
            .flatMap((c) => (c.type === "text" ? [c.text] : []))
            .join("\n") ||
            (state.status === "error"
              ? state.error.message
              : String(metadata.output ?? "")),
        ),
      ),
      cwd:
        typeof obj.workdir === "string"
          ? redact(obj.workdir)
          : typeof obj.cwd === "string"
            ? redact(obj.cwd)
            : undefined,
      exit:
        metadata.exit !== undefined
          ? String(metadata.exit)
          : metadata.exitCode !== undefined
            ? String(metadata.exitCode)
            : undefined,
      started: tool.time.ran ?? tool.time.created,
      ended: tool.time.completed,
      images,
      childSessionId:
        typeof metadata.sessionId === "string"
          ? metadata.sessionId
          : typeof metadata.sessionID === "string"
            ? metadata.sessionID
            : undefined,
    };
  };
  let selectedModel: ModelRef | undefined;
  let pending: RunDetail[] = [];
  let run:
    | {
        id: string;
        stage: string;
        started?: number;
        at: number;
        rowStart: number;
        details: RunDetail[];
        interrupted: boolean;
        interruptions: {
          id: string;
          error: { type: string; message: string };
          at: number;
        }[];
        errors: Set<string>;
      }
    | undefined;
  const modelText = (model: ModelRef) =>
    redact(
      `Модель: ${model.providerID}/${model.id}${model.variant ? ` · ${model.variant}` : ""}`,
    );
  const detail = (value: RunDetail) => {
    const target = run?.details ?? pending;
    const index = target.findIndex((d) => d.id === value.id);
    const entry = { ...value, text: redact(value.text) };
    if (index < 0) target.push(entry);
    else target[index] = entry;
  };
  const startRun = (id: string, at: number, started?: number) => {
    if (run) return;
    run = {
      id: `run:${id}`,
      stage: "Обрабатывает запрос",
      started,
      at,
      rowStart: rows.length,
      details: pending,
      interrupted: false,
      interruptions: [],
      errors: new Set(),
    };
    pending = [];
    if (selectedModel && !run.details.some((d) => d.kind === "model"))
      detail({
        id: `${run.id}:model`,
        kind: "model",
        text: modelText(selectedModel),
      });
  };
  const errorRow = (
    id: string,
    error: { type: string; message: string },
    at: number,
    forceError = false,
  ) => {
    const stopped = !forceError && interrupted(error);
    const text = redact(error.message);
    if (!stopped && run?.errors.has(text)) return;
    detail({
      id: `${id}:error-detail`,
      kind: "event",
      text: `${error.type}: ${error.message}`,
      status: stopped ? "interrupted" : "error",
    });
    if (stopped) {
      if (run) {
        run.interrupted = true;
        run.interruptions.push({ id, error, at });
      }
      return;
    }
    run?.errors.add(text);
    rows.push({ id: `${id}:error`, type: "system", text, status: "error", at });
  };
  const finishRun = (
    at: number,
    outcome?: "succeeded" | "interrupted" | "failed",
  ) => {
    if (!run) return;
    const status =
      outcome ??
      (running
        ? "running"
        : run.errors.size
          ? "failed"
          : run.interrupted
            ? "interrupted"
            : run.started !== undefined
              ? "interrupted"
              : "info");
    if (status !== "running") {
      for (const row of rows.slice(run.rowStart)) {
        if (row.type !== "actions") continue;
        for (const tool of row.tools) {
          if (tool.status === "running" || tool.status === "streaming")
            tool.status = status === "interrupted" ? "interrupted" : "unknown";
        }
      }
    }
    if (status !== "info" || run.details.length)
      rows.push({
        id: run.id,
        type: "run",
        at,
        started: run.started,
        text:
          status === "succeeded"
            ? "Готово"
            : status === "interrupted"
              ? "Остановлено"
              : status === "failed"
                ? "Завершено с ошибкой"
                : status === "running"
                  ? run.stage
                  : "Детали запуска",
        status,
        duration:
          outcome && run.started !== undefined
            ? Math.max(0, at - run.started)
            : undefined,
        details: run.details,
      });
    run = undefined;
  };
  for (const message of messages) {
    const at = message.time.created;
    if (message.type !== "assistant" || message.agent !== actionAgent)
      actionGroup = undefined;
    if (run) run.at = at;
    if (message.type === "user") {
      startRun(message.id, at, at);
      const images = message.files?.flatMap((f) => {
        if (!f.mime.startsWith("image/")) return [];
        const url = image(`data:${f.mime};base64,${f.data}`, f.name);
        return url ? [{ url, name: f.name ?? "Вложение" }] : [];
      });
      rows.push({
        id: message.id,
        type: "user",
        text: redact(message.text),
        at,
        images,
        attachments: message.files
          ?.filter((f) => !f.mime.startsWith("image/"))
          .map((f) => ({ name: f.name ?? "Документ", mime: f.mime })),
      });
    } else if (message.type === "assistant") {
      startRun(message.id, at);
      selectedModel = message.model;
      if (
        !run!.details.some(
          (d) => d.kind === "model" && d.text === modelText(message.model),
        )
      )
        detail({
          id: `${message.id}:model`,
          kind: "model",
          text: modelText(message.model),
        });
      message.content.forEach((part, index) => {
        if (part.type === "text" && part.text) run!.stage = "Формирует ответ";
        if (part.type === "text" && part.text)
          rows.push({
            id: `${message.id}:${index}`,
            type: "text",
            text: redact(part.text),
            at,
          });
        if (part.type === "tool")
          pushTool(convertTool(part), part.time.created, message.agent);
      });
      if (message.retry) {
        actionGroup = undefined;
        run!.stage = "Ожидает повторной попытки";
        detail({
          id: `${message.id}:retry`,
          kind: "event",
          text: `Повторная попытка ${message.retry.attempt}: ${redact(message.retry.error.message)}`,
        });
      }
      if (message.error) errorRow(message.id, message.error, at);
      if (message.error || (message.finish && message.finish !== "tool-calls"))
        actionGroup = undefined;
    } else if (message.type === "shell") {
      pushTool(
        {
          id: message.id,
          name: "shell",
          category: "shell",
          title: redact(message.command),
          command: redact(message.command),
          input: redact(message.command),
          output: redact(message.output?.output ?? ""),
          outputTruncated: message.output?.truncated || undefined,
          status:
            message.status === "running" && !running
              ? "unknown"
              : message.status,
          exit: message.exit === undefined ? undefined : String(message.exit),
          started: at,
          ended: message.time.completed,
          images: [],
        },
        at,
      );
    } else if (message.type === "idle") {
      startRun(message.id, at);
      if (message.outcome === "failed")
        for (const interruption of run!.interruptions)
          errorRow(interruption.id, interruption.error, interruption.at, true);
      if (message.error && message.outcome !== "interrupted")
        errorRow(message.id, message.error, at, message.outcome === "failed");
      if (message.error && message.outcome === "interrupted") {
        const text = redact(`${message.error.type}: ${message.error.message}`);
        if (!run!.details.some((d) => d.text === text))
          detail({
            id: `${message.id}:interruption`,
            kind: "event",
            text,
            status: "interrupted",
          });
      }
      finishRun(at, message.outcome);
    } else if (message.type === "compaction") {
      const event = {
        id: message.id,
        kind: "event" as const,
        text:
          message.status === "completed"
            ? "Контекст сжат"
            : message.status === "failed"
              ? "Ошибка сжатия контекста"
              : "Сжатие контекста",
        status: message.status === "failed" ? ("error" as const) : undefined,
      };
      if (run && message.status !== "failed") detail(event);
      else rows.push({ ...event, type: "system", at });
    } else if (message.type === "model-switched") {
      selectedModel = message.model;
      detail({ id: message.id, kind: "model", text: modelText(message.model) });
    } else if (message.type === "agent-switched") {
      detail({
        id: message.id,
        kind: "event",
        text: `Агент: ${message.agent}`,
      });
    } else if (message.type === "location-switched") {
      directory = message.location.directory;
      detail({
        id: message.id,
        kind: "event",
        text: `Рабочая папка: ${message.location.directory}`,
      });
    } else if (message.type === "system" || message.type === "synthetic") {
      const text = redact(message.description ?? message.text);
      if (run) detail({ id: message.id, kind: "event", text });
      else rows.push({ id: message.id, type: "system", text, at });
    } else if (message.type === "skill") {
      if (run)
        detail({ id: message.id, kind: "event", text: "Загружен навык" });
      else
        rows.push({
          id: message.id,
          type: "system",
          text: "Загружен навык",
          at,
        });
    }
  }
  if (run) finishRun(run.at);
  if (pending.length)
    rows.push({
      id: `run:${pending[0].id}`,
      type: "run",
      text: "Детали запуска",
      status: "info",
      at: messages.at(-1)?.time.created ?? 0,
      details: pending,
    });
  return rows;
}
