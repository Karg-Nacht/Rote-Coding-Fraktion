import { tr, useLanguage, trf } from "./i18n";
import { ModelCatalog } from "./ModelCatalog";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  LoaderCircle,
  Paperclip,
  Lightbulb,
  BookOpen,
  Square,
  X,
} from "lucide-react";
import type { Attachment, Mode } from "../shared/types";
import {
  api,
  attempt,
  openSession,
  refreshSessions,
  report,
  savePreferences,
  useApp,
} from "./store";
import { IconButton, Modal } from "./components";
import { ComposerModeControl, ComposerModelControl } from "./ComposerControls";
import { ComposerContext } from "./ComposerContext";
import { ProjectIntelligence, useProjectIntelligence } from "./ProjectIntelligence";
import { ComposerAddMenu } from "./ComposerAddMenu";
import {
  ATTACHMENT_LIMITS,
  formatAttachmentSize,
  parsePageRange,
} from "../shared/attachments";

export function Composer() {
  const language = useLanguage();

  const { preferences, snapshot, engine, models, projects, set } = useApp();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Attachment[]>([]);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [attachmentError, setAttachmentError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [preview, setPreview] = useState<Attachment | null>(null);
  const [pageRange, setPageRange] = useState("1");
  const [sending, setSending] = useState(false);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [showCatalog, setShowCatalog] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [skills, setSkills] = useState<string[]>([]);
  const [skillNames, setSkillNames] = useState<Record<string, string>>({});
  const hasOptions = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const composerAnchor = useRef<HTMLDivElement>(null);
  const workspace = preferences.workspace ?? "work";
  const contextProject = workspace === "chat" ? projects.find(
    (project) => project.id === preferences.projectId && !project.managed,
  ) : undefined;
  const intelligence = useProjectIntelligence(contextProject?.id, text.trim(), snapshot?.session.id);
  const key = useRef(
    preferences.sessionId ?? `new:${workspace}:composer`,
  ).current;
  const textValue = useRef(text);
  textValue.current = text;
  const optionValue = useRef({ planning, skills });
  optionValue.current = { planning, skills };
  const activeKey = useRef(key);
  activeKey.current = key;
  const running = snapshot?.session.running;
  const selected = models.find(
    (m) =>
      m.id === preferences.model?.id &&
      m.providerID === preferences.model.providerID,
  );
  const closeCatalog = useCallback(() => setShowCatalog(false), []);
  const closePreview = useCallback(() => setPreview(null), []);
  useEffect(() => {
    let active = true;
    setLoadedKey(null);
    setText("");
    setFiles([]);
    setAttachmentError("");
    setPreview(null);
    void Promise.all([
      api.loadDraft(key).then(async (value) => {
        if (value || preferences.sessionId) return value;
        const legacyKey = `new:${workspace}:${preferences.projectId ?? "none"}`;
        const legacy = await api.loadDraft(legacyKey);
        if (legacy) {
          await api.saveDraft(key, legacy);
          await api.saveDraft(legacyKey, "");
        }
        return legacy;
      }),
      api.loadDraft(`options:${key}`),
    ])
      .then(([value, options]) => {
        if (active) {
          setText(value);
          if (options) {
            try {
              const parsed = JSON.parse(options);
              hasOptions.current = true;
              setPlanning(workspace !== "chat" && parsed.planning === true);
              setSkills(
                Array.isArray(parsed.skills)
                  ? parsed.skills
                      .filter((id: unknown) => typeof id === "string")
                      .slice(0, 20)
                  : [],
              );
            } catch {
              /* Older draft options are optional. */
            }
          }
          setLoadedKey(key);
        }
      })
      .catch(report);
    return () => {
      active = false;
    };
  }, [key]);
  useEffect(() => {
    if (loadedKey !== key) return;
    const timer = setTimeout(
      () => void api.saveDraft(key, textValue.current).catch(report),
      300,
    );
    return () => {
      clearTimeout(timer);
      void api.saveDraft(key, textValue.current).catch(report);
    };
  }, [key, text, loadedKey]);
  useEffect(() => {
    if (loadedKey !== key) return;
    const save = () =>
      void api
        .saveDraft(`options:${key}`, JSON.stringify(optionValue.current))
        .catch(report);
    const timer = setTimeout(save, 250);
    return () => {
      clearTimeout(timer);
      save();
    };
  }, [key, loadedKey, planning, skills]);
  useEffect(() => {
    if (!hasOptions.current && snapshot?.session)
      setPlanning(workspace !== "chat" && snapshot.session.planning === true);
  }, [snapshot?.session.id, snapshot?.session.planning, workspace]);
  useEffect(() => {
    if (!skills.length) return;
    let active = true;
    void api
      .capabilities(preferences.projectId)
      .then((value) => {
        if (active)
          setSkillNames(
            Object.fromEntries(value.skills.map((s) => [s.id, s.name])),
          );
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [preferences.projectId, skills.join("|")]);
  useEffect(() => {
    if (input.current) {
      input.current.style.height = "auto";
      input.current.style.height = `${Math.min(200, Math.max(40, input.current.scrollHeight))}px`;
    }
  }, [text]);
  useEffect(() => {
    const handler = (event: Event) => {
      setText((event as CustomEvent<string>).detail);
      input.current?.focus();
    };
    window.addEventListener("forge:prompt", handler);
    return () => window.removeEventListener("forge:prompt", handler);
  }, []);
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string; text: string }>)
        .detail;
      if (detail.sessionId !== snapshot?.session.id) return;
      setText((old) => (old ? `${old}\n\n${detail.text}` : detail.text));
      input.current?.focus();
    };
    window.addEventListener("rcf:diff-comment", handler);
    return () => window.removeEventListener("rcf:diff-comment", handler);
  }, [snapshot?.session.id]);
  async function changeMode(value: Mode) {
    try {
      if (snapshot) await api.setMode(snapshot.session.id, value);
      await savePreferences({ mode: value });
    } catch (error) {
      report(error);
    }
  }
  async function submit() {
    if (
      (!text.trim() && !files.length) ||
      sending ||
      attachmentBusy ||
      intelligence.status.kind === "preparing" ||
      (intelligence.enabled && !text.trim()) ||
      !preferences.model ||
      !selected?.enabled ||
      engine.state !== "ready" || engine.compatibility?.canSend === false
    )
      return;
    if (
      files.some(
        (file) => file.mime.startsWith("image/") || !!file.visualPages?.length,
      ) &&
      selected &&
      !selected.image
    ) {
      setAttachmentError(
        tr(
          "Эта модель не поддерживает изображения. Выберите модель с поддержкой зрения или удалите изображения.",
        ),
      );
      return;
    }
    setSending(true);
    const draft = text.trim() || tr("Проанализируй прикреплённые файлы.");
    try {
      let projectContext;
      if (intelligence.enabled && contextProject) {
        const prepared = await intelligence.prepare();
        if (!prepared) return;
        if (!prepared.result.files) {
          intelligence.fail(new Error("Подходящие фрагменты не найдены. Уточните вопрос или выключите контекст проекта."));
          return;
        }
        projectContext = { projectId: contextProject.id, requestId: prepared.requestId };
      }
      const session =
        snapshot?.session ??
        (await api.createSession(
          preferences.projectId,
          preferences.model,
          workspace === "chat" || planning ? "cautious" : preferences.mode,
          workspace,
        ));
      await api.send(
        session.id,
        draft,
        preferences.model,
        workspace === "chat" ? "cautious" : preferences.mode,
        files.map((f) => f.id),
        { planning: workspace !== "chat" && planning, skills, projectContext },
      );
      if (projectContext) intelligence.cancel();
      textValue.current = "";
      setText("");
      setFiles([]);
      await api.saveDraft(key, "");
      if (!snapshot) {
        await api.saveDraft(
          `options:${session.id}`,
          JSON.stringify({ planning, skills }),
        );
        optionValue.current = { planning: false, skills: [] };
        setPlanning(false);
        setSkills([]);
        await api.saveDraft(`options:${key}`, "");
        const bootstrap = await api.bootstrap();
        useApp.getState().set({ projects: bootstrap.projects });
        await openSession(session);
      }
      await refreshSessions();
    } catch (error) {
      if (intelligence.enabled) intelligence.fail(error);
      else report(error);
    } finally {
      setSending(false);
      input.current?.focus();
    }
  }
  function addFiles(chosen: Attachment[]) {
    if (files.length + chosen.length > ATTACHMENT_LIMITS.files) {
      setAttachmentError(
        tr("Можно прикрепить до 20 файлов. Удалите лишние вложения."),
      );
      return;
    }
    if (
      [...files, ...chosen].reduce(
        (total, file) => total + (file.size ?? 0),
        0,
      ) > ATTACHMENT_LIMITS.requestBytes
    ) {
      setAttachmentError(
        tr(
          "Общий размер вложений должен быть до 40 МБ. Удалите лишние вложения.",
        ),
      );
      return;
    }
    setFiles((previous) => [...previous, ...chosen]);
    return true;
  }
  async function importFiles(chosen: File[]) {
    if (!chosen.length || attachmentBusy || sending) return;
    setAttachmentError("");
    if (
      files.length + chosen.length > ATTACHMENT_LIMITS.files ||
      chosen.some((file) => file.size > ATTACHMENT_LIMITS.fileBytes)
    ) {
      setAttachmentError(
        tr("Можно прикрепить до 20 файлов размером до 20 МБ каждый."),
      );
      return;
    }
    if (
      chosen.reduce(
        (size, file) => size + file.size,
        files.reduce((size, file) => size + (file.size ?? 0), 0),
      ) > ATTACHMENT_LIMITS.requestBytes
    ) {
      setAttachmentError(tr("Общий размер вложений должен быть до 40 МБ."));
      return;
    }
    const owner = key;
    setAttachmentBusy(true);
    try {
      // Only bytes cross IPC. Renderer-supplied local paths are never trusted.
      const imported = await api.importAttachments(
        await Promise.all(
          chosen.map(async (file) => ({
            name: file.name,
            mime: file.type,
            bytes: new Uint8Array(await file.arrayBuffer()),
          })),
        ),
      );
      if (activeKey.current === owner) return addFiles(imported);
    } catch (error) {
      if (activeKey.current === owner)
        setAttachmentError(
          error instanceof Error ? error.message : String(error),
        );
    } finally {
      setAttachmentBusy(false);
    }
  }
  async function chooseFiles() {
    if (attachmentBusy || sending) return;
    const owner = key;
    setAttachmentBusy(true);
    setAttachmentError("");
    try {
      const chosen = await api.attachments();
      if (activeKey.current === owner) addFiles(chosen);
    } catch (error) {
      if (activeKey.current === owner)
        setAttachmentError(
          error instanceof Error ? error.message : String(error),
        );
    } finally {
      setAttachmentBusy(false);
    }
  }
  async function chooseFolder() {
    if (attachmentBusy || sending) return;
    setAttachmentBusy(true);
    setAttachmentError("");
    try {
      addFiles(await api.attachFolder());
    } catch (error) {
      setAttachmentError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setAttachmentBusy(false);
    }
  }
  async function attachText(name: string, value: string) {
    const attached = await importFiles([
      new File(
        [value],
        `${name.replace(/[\\/:*?"<>|]/g, "_").replace(/\.txt$/i, "") || "context"}.txt`,
        { type: "text/plain" },
      ),
    ]);
    if (!attached) throw new Error(tr("Не удалось прикрепить контекст."));
  }
  function showPreview(file: Attachment) {
    setPageRange(file.visualPages?.join(", ") || "1");
    setPreview(file);
  }
  async function preparePages() {
    if (!preview || attachmentBusy) return;
    const owner = key;
    try {
      const pages = parsePageRange(pageRange, preview.pages ?? 1);
      setAttachmentBusy(true);
      setAttachmentError("");
      const prepared = await api.preparePdfAttachment(preview.id, pages);
      if (activeKey.current !== owner) return;
      setFiles((previous) =>
        previous.map((file) => (file.id === prepared.id ? prepared : file)),
      );
      setPreview(prepared);
    } catch (error) {
      if (activeKey.current === owner)
        setAttachmentError(
          error instanceof Error ? error.message : String(error),
        );
    } finally {
      setAttachmentBusy(false);
    }
  }
  const unsupportedImages =
    files.some(
      (file) => file.mime.startsWith("image/") || !!file.visualPages?.length,
    ) &&
    selected &&
    !selected.image;
  const canSend =
    (text.trim() || files.length) &&
    (!intelligence.enabled || text.trim()) &&
    intelligence.status.kind !== "preparing" &&
    selected?.enabled &&
    engine.state === "ready" &&
    engine.compatibility?.canSend !== false &&
    !sending &&
    !attachmentBusy &&
    !unsupportedImages;
  return (
    <div className="composer-area">
      {snapshot?.queued.length ? (
        <div className="queue-strip">
          <span>
            {snapshot.queued.length} {tr(" в очереди")}
          </span>
          {snapshot.queued.map((item) => (
            <div key={item.id}>
              <span>{item.text}</span>
              <IconButton
                label={tr("Убрать из очереди")}
                onClick={() =>
                  void attempt(() =>
                    api.cancelQueued(snapshot.session.id, item.id),
                  )
                }
              >
                <X size={12} />
              </IconButton>
            </div>
          ))}
        </div>
      ) : null}
      <ComposerContext disabled={!!running || sending || attachmentBusy}>
        {workspace === "chat" && <ProjectIntelligence
          state={intelligence}
          available={!!contextProject}
          hasQuestion={!!text.trim()}
          busy={!!running || sending || attachmentBusy}
        />}
      </ComposerContext>
      <div
        className={`composer ${dragOver ? "drag-over" : ""}`}
        ref={composerAnchor}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setDragOver(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setDragOver(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          void importFiles(Array.from(event.dataTransfer.files));
        }}
      >
        {!!files.length && (
          <div className="attachment-strip">
            {files.map((file) => (
              <div
                className={`attachment-chip attachment-card ${file.status === "warning" ? "attachment-warning" : ""}`}
                key={file.id}
              >
                <button
                  className="attachment-preview-button"
                  onClick={() => showPreview(file)}
                  title={file.detail ?? file.name}
                >
                  {file.preview ? (
                    <img src={file.preview} alt="" />
                  ) : (
                    <Paperclip size={14} />
                  )}
                  <span>
                    <span>{file.name}</span>
                    <small className="attachment-meta">
                      {file.mime === "application/pdf"
                        ? "PDF"
                        : file.mime.startsWith("image/")
                          ? tr("Изображение")
                          : tr("Текст")}{" "}
                      · {formatAttachmentSize(file.size, language)}
                      {file.pages ? trf` · ${file.pages} стр.` : ""}
                    </small>
                  </span>
                </button>
                <IconButton
                  label={trf`Удалить ${file.name}`}
                  onClick={() =>
                    setFiles(files.filter((f) => f.id !== file.id))
                  }
                >
                  <X size={13} />
                </IconButton>
              </div>
            ))}
          </div>
        )}
        {!!skills.length && (
          <div className="skill-chip-strip">
            {skills.map((id) => (
              <span className="skill-context-chip" key={id}>
                <BookOpen size={12} />
                <span>{skillNames[id] ?? id.split(/[\\/]/).pop()}</span>
                <IconButton
                  label={trf`Убрать навык ${skillNames[id] ?? id}`}
                  disabled={!!running || sending}
                  onClick={() =>
                    setSkills(skills.filter((value) => value !== id))
                  }
                >
                  <X size={11} />
                </IconButton>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={input}
          aria-label={tr("Сообщение агенту")}
          placeholder={
            planning
              ? tr("Опишите задачу для плана…")
              : tr("Опишите задачу для агента…")
          }
          value={text}
          onChange={(event) => setText(event.target.value)}
          onPaste={(event) => {
            const pasted = Array.from(event.clipboardData.files);
            if (!pasted.length) return;
            event.preventDefault();
            void importFiles(pasted);
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void submit();
            }
          }}
          spellCheck={false}
          disabled={sending}
        />
        {attachmentBusy && (
          <div className="attachment-processing" role="status">
            <LoaderCircle className="spin" size={14} />{" "}
            {tr(" Готовим вложения локально…")}
          </div>
        )}
        {!!attachmentError && (
          <div className="attachment-error" role="alert">
            {tr(attachmentError)}
          </div>
        )}
        <div className="composer-toolbar">
          <div className="composer-left">
            <ComposerAddMenu
              surfaceAnchor={composerAnchor}
              disabled={attachmentBusy || sending}
              running={!!running}
              projectId={preferences.projectId}
              workspace={workspace}
              planning={planning}
              setPlanning={setPlanning}
              skills={skills}
              setSkills={setSkills}
              onFiles={() => void chooseFiles()}
              onFolder={() => void chooseFolder()}
              onText={attachText}
            />
            {workspace === "chat" ? (
              <span className="chat-mode-note">
                {tr("Chat Faction · инструменты отключены")}
              </span>
            ) : (
              <ComposerModeControl
                disabled={!!running || sending}
                changeMode={changeMode}
              />
            )}
            {planning && (
              <button
                className="planning-chip"
                disabled={!!running || sending}
                aria-label={tr("Выключить режим планирования")}
                title={tr("Планирование · без изменений файлов и команд")}
                onClick={() => setPlanning(false)}
              >
                <Lightbulb size={12} />
                <span>{tr("План")}</span>
                <X size={10} />
              </button>
            )}
          </div>
          <div className="composer-right">
            <ComposerModelControl
              disabled={!!running || sending}
              openCatalog={() => setShowCatalog(true)}
            />
            {running ? (
              <IconButton
                label={tr("Остановить агента")}
                className="send-button stop-button"
                onClick={() =>
                  void attempt(() => api.stop(snapshot!.session.id))
                }
              >
                <Square size={13} fill="currentColor" />
              </IconButton>
            ) : (
              <button
                className="send-button"
                aria-label={tr("Отправить сообщение")}
                disabled={!canSend}
                onClick={() => void submit()}
              >
                {sending ? (
                  <LoaderCircle className="spin" size={17} />
                ) : (
                  <ArrowUp size={18} />
                )}
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="composer-footnote">
        {unsupportedImages ? (
          tr(
            "Эта модель не принимает изображения. Выберите модель с поддержкой зрения.",
          )
        ) : workspace !== "chat" && selected && !selected.tools ? (
          tr("По метаданным движка эта модель не поддерживает инструменты.")
        ) : (
          <>
            <span>
              {projects.find(
                (p) => p.id === preferences.projectId && !p.managed,
              )?.name ?? tr("Локальная задача")}
            </span>
            <span>
              {running
                ? tr("Esc Esc — остановить · Shift Enter — новая строка")
                : tr("Enter — отправить · Shift Enter — новая строка")}
            </span>
          </>
        )}
      </div>
      {preview && (
        <Modal
          title={preview.name}
          close={closePreview}
          wide
          className="attachment-detail"
        >
          <p className="attachment-meta">
            {preview.mime} · {formatAttachmentSize(preview.size, language)}
            {preview.pages ? trf` · ${preview.pages} страниц` : ""}
          </p>
          <p>{preview.detail}</p>
          {preview.preview && (
            <img
              className="attachment-detail-image"
              src={preview.preview}
              alt={
                preview.mime === "application/pdf"
                  ? trf`Предпросмотр первой подготовленной страницы ${preview.name}`
                  : preview.name
              }
            />
          )}
          {preview.excerpt && (
            <pre className="attachment-text-preview">{preview.excerpt}</pre>
          )}
          {preview.mime === "application/pdf" && (
            <div className="pdf-page-controls">
              <label htmlFor="pdf-page-range">
                {tr("Страницы для визуального анализа")}
              </label>
              <input
                id="pdf-page-range"
                value={pageRange}
                onChange={(event) => setPageRange(event.target.value)}
                placeholder="1, 3-5"
                disabled={attachmentBusy}
              />
              <button
                className="secondary"
                disabled={attachmentBusy}
                onClick={() => void preparePages()}
              >
                {attachmentBusy
                  ? tr("Готовим страницы…")
                  : tr("Подготовить текст и изображения")}
              </button>
              <small>
                {tr(
                  "До 6 страниц. Изображения требуют модели с поддержкой зрения; OCR не выполняется.",
                )}
              </small>
              {preview.visualPages?.length ? (
                <small>
                  {tr("Подготовлены изображения страниц:")}{" "}
                  {preview.visualPages.join(", ")}
                  {tr(". Превью показывает первую страницу.")}
                </small>
              ) : null}
            </div>
          )}
          {!!attachmentError && (
            <p className="attachment-error" role="alert">
              {tr(attachmentError)}
            </p>
          )}
        </Modal>
      )}
      {showCatalog && <ModelCatalog close={closeCatalog} />}
    </div>
  );
}
