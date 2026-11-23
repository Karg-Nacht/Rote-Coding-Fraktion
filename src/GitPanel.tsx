import { tr, useLanguage, trf } from "./i18n";
import { useCallback, useEffect, useState } from "react";
import {
  Check,
  ChevronRight,
  ExternalLink,
  FileCode2,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  LoaderCircle,
  RefreshCw,
  Upload,
  Download,
  X,
} from "lucide-react";
import type { FileDiff, GitStatus, Project, Session } from "../shared/types";
import { api, attempt, report } from "./store";
import { Empty, IconButton, Modal } from "./components";
import { diffLines } from "../shared/diff";

export function DiffViewer({
  patch,
  inline = false,
}: {
  patch: string;
  inline?: boolean;
}) {
  useLanguage();

  const [html, setHtml] = useState("");
  const [full, setFull] = useState(false);
  const inlinePreview = inline ? patch.slice(0, 24000).split("\n").slice(0, 100).join("\n") : patch;
  const limited = !inline && patch.length > 300000 && !full;
  const text = limited ? patch.slice(0, 300000) : inlinePreview;
  useEffect(() => {
    let active = true;
    setHtml("");
    if (text.length <= 300000)
      void import("./highlight")
        .then((s) => s.highlightDiff(text, inline))
        .then((html) => {
          if (active) setHtml(html);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [text, inline]);
  return (
    <div className={`diff-content ${inline ? "inline-diff" : ""}`} tabIndex={inline ? 0 : undefined}>
      {html ? (
        <div dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre>{text || tr("Изменений нет")}</pre>
      )}
      {inline && text.length < patch.length && <p className="diff-preview-note">{tr("Показан начальный фрагмент diff.")}</p>}
      {limited && (
        <button className="secondary" onClick={() => setFull(true)}>
          {tr("Показать полный diff (")}
          {Math.round(patch.length / 1024)} {tr(" КБ)")}
        </button>
      )}
    </div>
  );
}
export function GitPanel({
  project,
  session,
  close,
}: {
  project: Project;
  session?: Session;
  close: () => void;
}) {
  useLanguage();

  const [status, setStatus] = useState<GitStatus>();
  const [diffs, setDiffs] = useState<FileDiff[]>([]);
  const [tab, setTab] = useState<"git" | "session">("git");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [diff, setDiff] = useState<{ file: string; patch: string }>();
  const [operation, setOperation] = useState<"branch" | "commit" | "pr">();
  const [value, setValue] = useState("");
  const [body, setBody] = useState("");
  const [output, setOutput] = useState("");
  const [comment, setComment] = useState("");
  const [commentLine, setCommentLine] = useState("");
  const fileNames =
    tab === "session"
      ? diffs.map((d) => d.file)
      : (status?.files.map((f) => f.path) ?? []);
  const showFile = async (file: string) => {
    setComment("");
    setCommentLine("");
    setDiff({
      file,
      patch:
        tab === "session"
          ? (diffs.find((d) => d.file === file)?.patch ?? "")
          : session
            ? await api.taskGitDiff(session.id, file)
            : await api.gitDiff(project.id, file),
    });
  };
  const reload = useCallback(async () => {
    setBusy(true);
    try {
      const next = session
        ? await api.taskGitStatus(session.id)
        : await api.gitStatus(project.id);
      setStatus(next);
      if (session) setDiffs(await api.sessionDiff(session.id));
      else setDiffs([]);
    } finally {
      setBusy(false);
    }
  }, [project.id, session?.id]);
  useEffect(() => {
    setStatus(undefined);
    setSelected([]);
    void attempt(reload);
  }, [reload]);
  const action = async (
    action: "push" | "pull" | "branch" | "commit" | "pr",
  ) => {
    setBusy(true);
    try {
      setOutput(
        (await api.gitAction(project.id, action, value, body, session?.id)) ||
          tr("Операция выполнена."),
      );
      setOperation(undefined);
      setValue("");
      setBody("");
      await reload();
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  };
  const closeDiff = useCallback(() => setDiff(undefined), []);
  const closeOperation = useCallback(() => setOperation(undefined), []);
  return (
    <aside className="git-panel">
      <header>
        <span>
          <GitBranch size={16} />
          {tr("Изменения")}
        </span>
        <div>
          <IconButton
            label={tr("Обновить изменения")}
            onClick={() => void attempt(reload)}
            disabled={busy}
          >
            <RefreshCw size={14} className={busy ? "spin" : ""} />
          </IconButton>
          <IconButton label={tr("Закрыть изменения")} onClick={close}>
            <X size={16} />
          </IconButton>
        </div>
      </header>
      <div className="git-tabs">
        <button
          aria-pressed={tab === "git"}
          className={tab === "git" ? "selected" : ""}
          onClick={() => setTab("git")}
        >
          {tr("Рабочая папка")}
        </button>
        <button
          aria-pressed={tab === "session"}
          className={tab === "session" ? "selected" : ""}
          onClick={() => setTab("session")}
          disabled={!session}
        >
          {tr("Эта задача")}
        </button>
      </div>
      <div className="git-body">
        <p className="rcf-directory" title={session?.directory ?? project.path}>
          {session?.directory ?? project.path}
        </p>
        {fileNames.length > 0 && (
          <button
            className="secondary"
            onClick={() =>
              void attempt(async () => {
                const patches =
                  tab === "session"
                    ? diffs.map((d) => d.patch)
                    : await Promise.all(
                        fileNames.map((file) =>
                          session
                            ? api.taskGitDiff(session.id, file)
                            : api.gitDiff(project.id, file),
                        ),
                      );
                setDiff({ file: "Full diff", patch: patches.join("\n\n") });
              })
            }
          >
            Full diff · {fileNames.length} files
          </button>
        )}
        {tab === "session" ? (
          <>
            {diffs.length ? (
              <>
                <div className="diff-total">
                  {tr("Изменено файлов: ")}
                  {diffs.length}
                  <span>
                    <b className="green">
                      +{diffs.reduce((s, f) => s + f.additions, 0)}
                    </b>{" "}
                    <b className="red">
                      −{diffs.reduce((s, f) => s + f.deletions, 0)}
                    </b>
                  </span>
                </div>
                {diffs.map((file) => (
                  <button
                    className="diff-file"
                    title={file.file}
                    key={file.file}
                    onClick={() =>
                      setDiff({ file: file.file, patch: file.patch })
                    }
                  >
                    <FileCode2 size={14} />
                    <span>
                      {file.file}
                      <small>
                        {file.status}
                        {file.more ? tr(" · частичный diff движка") : ""}
                      </small>
                    </span>
                    <span className="diff-stats">
                      <b className="green">+{file.additions}</b>
                      <b className="red">−{file.deletions}</b>
                    </span>
                    <ChevronRight size={12} />
                  </button>
                ))}
              </>
            ) : (
              <Empty>
                {tr("OpenCode пока не сообщил об изменениях этой задачи.")}
              </Empty>
            )}
          </>
        ) : !status ? (
          <Empty>
            <LoaderCircle className="spin" size={18} />
          </Empty>
        ) : !status.repository ? (
          <Empty>
            {status.error ?? tr("В этой папке нет Git репозитория.")}
          </Empty>
        ) : (
          <>
            <div className="git-branch">
              <GitBranch size={14} />
              <span>{status.branch}</span>
              <button
                className="text-button"
                onClick={() => {
                  setOperation("branch");
                  setValue("");
                }}
              >
                {tr("Новая ветка")}
              </button>
            </div>
            <div className="git-toolbar">
              <button
                className="secondary"
                onClick={() => void action("pull")}
                disabled={busy}
              >
                <Download size={13} />
                Pull
              </button>
              <button
                className="secondary"
                onClick={() => void action("push")}
                disabled={busy}
              >
                <Upload size={13} />
                Push
              </button>
              <button
                className="secondary"
                disabled={busy || !status.gh}
                title={
                  status.gh
                    ? `GitHub: ${status.ghAccount}`
                    : tr("Требуется gh auth login")
                }
                onClick={() => {
                  setOperation("pr");
                  setValue("");
                  setBody("");
                }}
              >
                <GitPullRequest size={13} />
                PR
              </button>
            </div>
            <div className="changes-label">
              {status.files.length} {tr(" изменённых файлов")}
            </div>
            {[...status.files]
              .sort((a, b) => a.path.localeCompare(b.path))
              .map((file, index, files) => (
                <div key={file.path}>
                  {(index === 0 ||
                    files[index - 1].path.split("/").slice(0, -1).join("/") !==
                      file.path.split("/").slice(0, -1).join("/")) && (
                    <p
                      className="changes-label"
                      title={file.path.split("/").slice(0, -1).join("/")}
                    >
                      {file.path.split("/").slice(0, -1).join("/") || "/"}
                    </p>
                  )}
                  <div className="git-file-row">
                    <input
                      type="checkbox"
                      aria-label={trf`Выбрать ${file.path}`}
                      checked={selected.includes(file.path)}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? [...selected, file.path]
                            : selected.filter((f) => f !== file.path),
                        )
                      }
                    />
                    <button
                      className="diff-file"
                      title={file.path}
                      onClick={() =>
                        void attempt(async () =>
                          setDiff({
                            file: file.path,
                            patch: session
                              ? await api.taskGitDiff(session.id, file.path)
                              : await api.gitDiff(project.id, file.path),
                          }),
                        )
                      }
                    >
                      <span className="file-status">{file.status.trim()}</span>
                      <span>{file.path}</span>
                      {file.additions !== undefined && (
                        <span className="diff-stats">
                          <b className="green">+{file.additions}</b>
                          <b className="red">−{file.deletions}</b>
                        </span>
                      )}
                    </button>
                  </div>
                </div>
              ))}
            {!status.files.length && (
              <Empty>
                <Check size={20} />
                {tr("Рабочая папка чиста")}
              </Empty>
            )}
            <div className="git-commit-tools">
              <button
                className="secondary"
                disabled={!selected.length || busy}
                onClick={() =>
                  void attempt(async () => {
                    await api.gitStage(project.id, selected, session?.id);
                    setSelected([]);
                    await reload();
                  })
                }
              >
                {tr("Добавить выбранные в индекс")}
              </button>
              <button
                className="primary"
                disabled={
                  busy ||
                  !status.files.some(
                    (f) => f.status[0] !== " " && f.status[0] !== "?",
                  )
                }
                onClick={() => {
                  setOperation("commit");
                  setValue("");
                }}
              >
                <GitCommitHorizontal size={14} />
                {tr("Коммит из индекса")}
              </button>
            </div>
            <p className="hint">
              {tr(
                "Перед коммитом выберите файлы и добавьте их в индекс. Push, pull и создание PR требуют отдельного подтверждения.",
              )}
            </p>
            {!status.gh && (
              <p className="hint">
                {tr("GitHub CLI не подключён. Авторизуйтесь через")}{" "}
                <code>gh auth login</code>
                {tr(", затем обновите панель.")}
              </p>
            )}
          </>
        )}
        {output && (
          <div className="git-output">
            <div>
              <span>{tr("Результат Git")}</span>
              <IconButton
                label={tr("Скрыть результат Git")}
                onClick={() => setOutput("")}
              >
                <X size={13} />
              </IconButton>
            </div>
            <pre>{output}</pre>
            {/https:\/\/github\.com\/\S+/.exec(output)?.[0] && (
              <button
                className="text-button"
                onClick={() =>
                  void attempt(() =>
                    api.openExternal(
                      /https:\/\/github\.com\/\S+/.exec(output)![0],
                    ),
                  )
                }
              >
                <ExternalLink size={13} />
                {tr("Открыть Pull Request")}
              </button>
            )}
          </div>
        )}
      </div>
      {diff && (
        <Modal title={diff.file} close={closeDiff} wide>
          {diff.file !== "Full diff" && (
            <div className="rcf-actions">
              <button
                className="secondary"
                disabled={fileNames.indexOf(diff.file) <= 0}
                onClick={() =>
                  void attempt(() =>
                    showFile(fileNames[fileNames.indexOf(diff.file) - 1]),
                  )
                }
              >
                Previous file
              </button>
              <button
                className="secondary"
                disabled={fileNames.indexOf(diff.file) >= fileNames.length - 1}
                onClick={() =>
                  void attempt(() =>
                    showFile(fileNames[fileNames.indexOf(diff.file) + 1]),
                  )
                }
              >
                Next file
              </button>
              {session && (
                <button
                  className="secondary"
                  onClick={() =>
                    void attempt(() => api.openTaskFile(session.id, diff.file))
                  }
                >
                  Open in external editor
                </button>
              )}
            </div>
          )}
          <DiffViewer patch={diff.patch} />
          {session && diff.file !== "Full diff" && (
            <form
              className="rcf-form"
              onSubmit={(e) => {
                e.preventDefault();
                const index = diffLines(diff.patch).findIndex(
                  (l) => l.next === Number(commentLine),
                );
                const excerpt =
                  index >= 0
                    ? diff.patch
                        .split("\n")
                        .slice(Math.max(0, index - 3), index + 4)
                        .join("\n")
                    : "";
                window.dispatchEvent(
                  new CustomEvent("rcf:diff-comment", {
                    detail: {
                      sessionId: session.id,
                      text: `Review comment: ${diff.file}${commentLine ? ":" + commentLine : ""} (observed diff; verify the current file before applying)\n${comment}${excerpt ? "\n\n" + excerpt : ""}`,
                    },
                  }),
                );
                setDiff(undefined);
              }}
            >
              <input
                aria-label="Diff line (new version)"
                type="number"
                min="1"
                placeholder="Line (optional)"
                value={commentLine}
                onChange={(e) => setCommentLine(e.target.value)}
              />
              <input
                aria-label="Diff comment"
                placeholder="Comment for the agent"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
              <button
                className="secondary"
                disabled={
                  !comment.trim() ||
                  (!!commentLine &&
                    !diffLines(diff.patch).some(
                      (l) => l.next === Number(commentLine),
                    ))
                }
              >
                Add to message draft
              </button>
            </form>
          )}
        </Modal>
      )}
      {operation && (
        <Modal
          title={
            operation === "branch"
              ? tr("Новая ветка")
              : operation === "commit"
                ? tr("Коммит")
                : tr("Черновик Pull Request")
          }
          close={closeOperation}
        >
          <form
            className="dialog-body"
            onSubmit={(e) => {
              e.preventDefault();
              void action(operation);
            }}
          >
            <label className="field">
              <span>
                {operation === "branch"
                  ? tr("Имя ветки")
                  : operation === "commit"
                    ? tr("Сообщение коммита")
                    : tr("Заголовок")}
              </span>
              <input
                autoFocus
                required
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </label>
            {operation === "pr" && (
              <label className="field">
                <span>{tr("Описание")}</span>
                <textarea
                  rows={7}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                />
              </label>
            )}
            {operation === "commit" && (
              <p className="hint">
                {tr("Будут включены все файлы, находящиеся в индексе Git.")}
              </p>
            )}
            <button className="primary" disabled={busy}>
              {busy && <LoaderCircle size={14} className="spin" />}
              {tr("Продолжить")}
            </button>
          </form>
        </Modal>
      )}
    </aside>
  );
}
