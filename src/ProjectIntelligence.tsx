import { useCallback, useEffect, useRef, useState } from "react";
import { FileCode2, LoaderCircle } from "lucide-react";
import type { ProjectContext } from "../shared/types";
import { api } from "./store";
import { Modal } from "./components";
import { tr, trf } from "./i18n";
import "./project-intelligence.css";

type Preparation = { requestId: string; result: ProjectContext };
type Status =
  | { kind: "idle" | "preparing" }
  | { kind: "ready"; result: ProjectContext }
  | { kind: "error"; message: string };

export function useProjectIntelligence(
  projectId: string | undefined,
  question: string,
  sessionId?: string,
) {
  const [optIn, setOptIn] = useState<string>();
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [previewOpen, setPreviewOpen] = useState(false);
  const operation = useRef<{
    id: string;
    promise: Promise<Preparation | undefined>;
  }>(undefined);
  const owner = JSON.stringify([projectId, sessionId]);
  const enabled = !!projectId && optIn === owner;

  const clearOperation = useCallback(() => {
    const current = operation.current;
    operation.current = undefined;
    if (current) void api.cancelProjectContext(current.id).catch(() => {});
  }, []);
  const cancel = useCallback(() => {
    clearOperation();
    setStatus({ kind: "idle" });
  }, [clearOperation]);

  useEffect(() => {
    setOptIn(undefined);
    setPreviewOpen(false);
  }, [owner]);
  useEffect(() => {
    setStatus({ kind: "idle" });
    return clearOperation;
  }, [owner, question, clearOperation]);

  function setEnabled(value: boolean) {
    setOptIn(value ? owner : undefined);
    if (!value) {
      cancel();
      setPreviewOpen(false);
    }
  }
  function prepare(): Promise<Preparation | undefined> {
    if (!enabled || !projectId || !question) return Promise.resolve(undefined);
    if (operation.current) return operation.current.promise;
    const id = crypto.randomUUID();
    setStatus({ kind: "preparing" });
    const promise = api
      .previewProjectContext(projectId, question, id, sessionId)
      .then(
        (result) => {
          if (operation.current?.id !== id) return undefined;
          setStatus({ kind: "ready", result });
          return { requestId: id, result };
        },
        (error: unknown) => {
          if (operation.current?.id !== id) return undefined;
          fail(error);
          return undefined;
        },
      );
    operation.current = { id, promise };
    return promise;
  }
  function fail(error: unknown) {
    clearOperation();
    const message = error instanceof Error ? error.message : String(error);
    setStatus({
      kind: "error",
      message: message.replace(
        /^Error invoking remote method '[^']+': (?:Error: )?/,
        "",
      ),
    });
  }
  function closePreview() {
    if (status.kind === "preparing") cancel();
    setPreviewOpen(false);
  }
  return {
    enabled,
    status,
    previewOpen,
    setEnabled,
    setPreviewOpen,
    cancel,
    prepare,
    fail,
    closePreview,
  };
}

export function ProjectIntelligence({
  state,
  available,
  hasQuestion,
  busy,
}: {
  state: ReturnType<typeof useProjectIntelligence>;
  available: boolean;
  hasQuestion: boolean;
  busy: boolean;
}) {
  const { enabled, status } = state;
  const statusLabel =
    status.kind === "preparing"
      ? tr("Готовим контекст…")
      : status.kind === "error"
        ? tr("Ошибка контекста")
        : status.kind === "ready"
          ? status.result.files
            ? tr("Контекст готов")
            : tr("Фрагменты не найдены")
          : enabled
            ? tr("Контекст включён")
            : available
              ? tr("Контекст проекта выключен")
              : tr("Контекст проекта");
  const privacy = tr(
    "Подходящие фрагменты кода будут отправлены выбранной модели с сообщением.",
  );
  return (
    <div className="project-intelligence">
      <button
        type="button"
        className={`context-chip ${enabled ? "active" : ""}`}
        aria-label={tr("Контекст проекта")}
        aria-pressed={enabled}
        aria-describedby={enabled ? "project-context-disclosure" : undefined}
        disabled={!available || busy}
        title={available ? privacy : tr("Выберите проект для контекста.")}
        onClick={() => state.setEnabled(!enabled)}
      >
        {status.kind === "preparing" ? (
          <LoaderCircle className="spin" size={13} />
        ) : (
          <FileCode2 size={13} />
        )}
        <span aria-live="polite">{statusLabel}</span>
      </button>
      {enabled &&
        (status.kind === "preparing" ? (
          <button
            className="context-chip"
            type="button"
            onClick={() => {
              state.cancel();
              state.setPreviewOpen(false);
            }}
          >
            {tr("Отменить подготовку")}
          </button>
        ) : (
          <button
            className="context-chip"
            type="button"
            disabled={!hasQuestion || busy}
            onClick={() => {
              state.setPreviewOpen(true);
              void state.prepare();
            }}
          >
            {tr("Посмотреть контекст")}
          </button>
        ))}
      {enabled && (
        <span
          id="project-context-disclosure"
          className="project-intelligence-note"
        >
          {privacy}
        </span>
      )}
      {enabled && status.kind === "error" && (
        <span className="project-intelligence-error" role="alert">
          {tr(status.message)}
        </span>
      )}
      {enabled && state.previewOpen && (
        <Modal
          wide
          className="project-intelligence-preview"
          title={tr("Контекст проекта")}
          close={state.closePreview}
        >
          <div className="dialog-body">
            {status.kind === "preparing" && (
              <p role="status">{tr("Готовим контекст…")}</p>
            )}
            {status.kind === "error" && <p>{tr(status.message)}</p>}
            {status.kind === "ready" && (
              <ContextPreview result={status.result} />
            )}
            {status.kind === "preparing" && (
              <button
                className="secondary"
                type="button"
                onClick={state.closePreview}
              >
                {tr("Отменить подготовку")}
              </button>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

function ContextPreview({ result }: { result: ProjectContext }) {
  const { excluded } = result;
  return (
    <>
      <p>{trf`Файлов: ${result.files} · Символов: ≈${result.characters.toLocaleString()} · Проверено файлов: ${result.scannedFiles}`}</p>
      {result.truncated && (
        <p>
          {tr(
            "Часть файлов или строк пропущена из-за ограничений размера и глубины.",
          )}
        </p>
      )}
      {Object.values(excluded).some(Boolean) && (
        <details>
          <summary>{tr("Исключения при сканировании")}</summary>
          <ul>
            {!!excluded.directories && (
              <li>{trf`Скрытые и сгенерированные папки: ${excluded.directories}`}</li>
            )}
            {!!excluded.files && (
              <li>{trf`Неподдерживаемые файлы: ${excluded.files}`}</li>
            )}
            {!!excluded.links && <li>{trf`Ссылки: ${excluded.links}`}</li>}
            {!!excluded.oversized && (
              <li>{trf`Файлы больше лимита: ${excluded.oversized}`}</li>
            )}
            {!!excluded.binary && (
              <li>{trf`Двоичные файлы или неподдерживаемая кодировка: ${excluded.binary}`}</li>
            )}
            {!!excluded.sensitive && (
              <li>{trf`Скрытые и потенциально конфиденциальные файлы: ${excluded.sensitive}`}</li>
            )}
            {!!excluded.unavailable && (
              <li>{trf`Недоступные или изменившиеся файлы: ${excluded.unavailable}`}</li>
            )}
          </ul>
        </details>
      )}
      {!result.files && (
        <p>
          {tr(
            "Подходящие фрагменты не найдены. Уточните вопрос или выключите контекст проекта.",
          )}
        </p>
      )}
      {result.excerpts.map((excerpt) => (
        <details key={`${excerpt.path}:${excerpt.startLine}`} open>
          <summary>
            <code>
              {excerpt.path}:{excerpt.startLine}–{excerpt.endLine}
            </code>
          </summary>
          <pre>{excerpt.text}</pre>
        </details>
      ))}
    </>
  );
}
