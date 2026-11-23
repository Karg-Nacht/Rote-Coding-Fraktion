import { useCallback, useEffect, useRef, useState } from "react";
import {
  GitBranch,
  Folder,
  ChartNoAxesColumn,
  Layers,
  RefreshCw,
  ArrowUpLeft,
  Square,
  Plus,
  X,
  Users,
  History,
  FileCheck2,
  ChevronDown,
  LoaderCircle,
} from "lucide-react";
import type { ModelRef, Project, Session } from "../shared/types";
import type {
  AgentDefinition,
  AgentRun,
  Checkpoint,
  ReviewReport,
  Worktree,
} from "../shared/rcf";
import {
  api,
  attempt,
  openSession,
  refreshSessions,
  report,
  useApp,
} from "./store";
import { FloatingPanel, Modal, IconButton } from "./components";
import { CustomSelect } from "./CustomSelect";
import { DiffViewer } from "./GitPanel";
import { tr, useLanguage } from "./i18n";
import "./task-control.css";

const modelKey = (model?: ModelRef) =>
  model ? `${model.providerID}\n${model.id}` : "";
const sameDirectory = (a?: string, b?: string) =>
  !!a &&
  !!b &&
  a.replaceAll("\\", "/").toLowerCase() ===
    b.replaceAll("\\", "/").toLowerCase();
const agentName = (id: string) =>
  ({
    "rcf-reader": tr("Исследователь"),
    "rcf-reviewer": tr("Рецензент"),
    build: tr("Разработчик"),
    general: tr("Универсальный помощник"),
    explore: tr("Поиск по проекту"),
    plan: tr("Планировщик"),
  })[id] ?? id;
const statusName = (status: string) =>
  ({
    Waiting: tr("Ожидает"),
    Running: tr("Работает"),
    Completed: tr("Завершено"),
    Failed: tr("Ошибка"),
    Interrupted: tr("Остановлено"),
    Unknown: tr("Статус неизвестен"),
  })[status] ?? status;
const elapsed = (session: Session) =>
  Math.max(
    0,
    Math.round(
      ((session.running ? Date.now() : (session.idle ?? session.updated)) -
        (session.busy ?? session.created)) /
        1000,
    ),
  );

export function TaskControl({
  project,
  session,
}: {
  project: Project;
  session?: Session;
}) {
  useLanguage();
  const state = useApp();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("Worktrees");
  const [trees, setTrees] = useState<Worktree[]>([]);
  const [treesLoaded, setTreesLoaded] = useState(false);
  const [detailsLoaded, setDetailsLoaded] = useState(false);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [definitions, setDefinitions] = useState<AgentDefinition[]>([]);
  const [points, setPoints] = useState<Checkpoint[]>([]);
  const [review, setReview] = useState<ReviewReport>();
  const [branch, setBranch] = useState("rcf/");
  const [task, setTask] = useState("");
  const [agent, setAgent] = useState("rcf-reader");
  const [directory, setDirectory] = useState("");
  const [selectedModel, setSelectedModel] = useState(
    modelKey(session?.model ?? state.preferences.model),
  );
  const [busy, setBusy] = useState(false);
  const [patch, setPatch] = useState<string>();
  const [addingTree, setAddingTree] = useState(false);
  const [addingAgent, setAddingAgent] = useState(false);
  const [projectPoint, setProjectPoint] = useState<{ x: number; y: number }>();
  const metricsRef = useRef<HTMLDetailsElement>(null);
  const sourceId = session?.reviewSourceId ?? session?.id;
  const model = state.models.find((m) => modelKey(m) === selectedModel);
  const reader = agent === "rcf-reader";
  const availableTrees = trees.filter(
    (t) =>
      reader || !sameDirectory(t.directory, session?.directory ?? project.path),
  );
  const close = useCallback(() => {
    setOpen(false);
    setPatch(undefined);
  }, []);
  const show = (nextTab?: string) => {
    setProjectPoint(undefined);
    if (metricsRef.current) metricsRef.current.open = false;
    if (nextTab) setTab(nextTab);
    setOpen(true);
  };
  const reload = useCallback(async () => {
    setTrees(await api.worktrees(project.id));
    setTreesLoaded(true);
    if (sourceId && open) {
      const [nextRuns, nextDefinitions, nextPoints] = await Promise.all([
        api.agentRuns(sourceId),
        api.agents(sourceId),
        api.checkpoints(sourceId),
      ]);
      setRuns(nextRuns);
      setDefinitions(nextDefinitions);
      setPoints(nextPoints);
      const reviewId = session?.reviewSourceId
        ? session.id
        : nextRuns.find((r) => r.session.reviewSourceId)?.session.id;
      setReview(reviewId ? await api.reviewReport(reviewId) : undefined);
      setDetailsLoaded(true);
    }
  }, [project.id, sourceId, open, session?.id, session?.reviewSourceId]);
  useEffect(() => {
    void attempt(reload);
  }, [reload]);
  useEffect(() => {
    if (!open) return;
    let pending = false;
    const timer = setInterval(() => {
      if (!pending) {
        pending = true;
        void reload()
          .catch(report)
          .finally(() => {
            pending = false;
          });
      }
    }, 2500);
    return () => clearInterval(timer);
  }, [open, reload]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (
        metricsRef.current &&
        !metricsRef.current.contains(event.target as Node)
      )
        metricsRef.current.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && metricsRef.current)
        metricsRef.current.open = false;
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await refreshSessions();
      await reload();
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  };
  const enter = async (next: Session) => {
    await refreshSessions();
    await openSession(next);
    close();
  };
  const currentTree = trees.find((t) =>
    sameDirectory(t.directory, session?.directory),
  );
  const metrics = state.snapshot?.metrics;
  const loading =
    tab === "Worktrees" ? !treesLoaded : !!sourceId && !detailsLoaded;
  const tabs = [
    { id: "Worktrees", label: tr("Рабочие копии"), icon: GitBranch },
    { id: "Agent Control", label: tr("Помощники"), icon: Users },
    { id: "Code Review", label: tr("Проверка изменений"), icon: FileCheck2 },
    { id: "Checkpoints", label: tr("История задачи"), icon: History },
  ];
  const models = (placeholder = tr("По умолчанию")) => [
    { value: "", label: placeholder },
    ...state.models
        .filter((m) => m.enabled)
        .map((m) => ({ value: modelKey(m), label: `${m.providerID}/${m.id}` })),
  ];
  return (
    <>
      <div className="rcf-context">
        <button
          className="rcf-location"
          disabled={state.loading}
          data-menu-trigger
          aria-expanded={!!projectPoint}
          aria-haspopup="dialog"
          onClick={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            if (metricsRef.current) metricsRef.current.open = false;
            setProjectPoint(
              projectPoint ? undefined : { x: box.left, y: box.bottom + 8 },
            );
          }}
          title={session?.directory ?? project.path}
        >
          <Folder size={14} />
          <span>{project.name}</span>
          {currentTree?.branch && (
            <span className="rcf-branch">{currentTree.branch}</span>
          )}
          <ChevronDown size={12} />
        </button>
        <code
          className="rcf-directory"
          hidden
          aria-hidden="true"
          title={session?.directory ?? project.path}
        >
          {session?.directory ?? project.path}
        </code>
        <div className="rcf-task-actions">
          {(session?.parentId || session?.reviewSourceId) && (
            <button
              className="rcf-parent"
              title={tr("Вернуться к основной задаче")}
              onClick={() =>
                void attempt(async () =>
                  enter(
                    (
                      await api.openSession(
                        (session.parentId ?? session.reviewSourceId)!,
                      )
                    ).session,
                  ),
                )
              }
            >
              <ArrowUpLeft size={13} />
              {tr("К задаче")}
            </button>
          )}
          <button
            className="rcf-controls-button"
            aria-label={tr("Управление задачей")}
            title={tr("Управление задачей")}
            disabled={state.loading}
            onClick={() => show()}
          >
            <Layers size={13} />
            {tr("Задача")}
          </button>
          {session && metrics && (
            <details className="rcf-metrics" ref={metricsRef}>
              <summary
                aria-label={tr("Сведения о сеансе")}
                title={tr("Сведения о сеансе")}
              >
                <ChartNoAxesColumn size={16} />
              </summary>
              <div>
                <strong>
                  {session.model?.providerID}/{session.model?.id}
                </strong>
                <dl>
                  <dt>{tr("Усилие модели")}</dt>
                  <dd>{session.model?.variant ?? tr("По умолчанию")}</dd>
                  <dt>{tr("Токены · вход / выход")}</dt>
                  <dd>
                    {metrics.input.toLocaleString()} /{" "}
                    {metrics.output.toLocaleString()}
                  </dd>
                  <dt>{tr("Рассуждение")}</dt>
                  <dd>{metrics.reasoning.toLocaleString()}</dd>
                  <dt>{tr("Кэш · чтение / запись")}</dt>
                  <dd>
                    {metrics.cacheRead.toLocaleString()} /{" "}
                    {metrics.cacheWrite.toLocaleString()}
                  </dd>
                  <dt>{tr("Стоимость по данным движка")}</dt>
                  <dd>${metrics.cost.toFixed(6)}</dd>
                  <dt>{tr("Последний вход / контекст")}</dt>
                  <dd>
                    {metrics.contextInput?.toLocaleString() ?? "—"} /{" "}
                    {state.models
                      .find(
                        (m) =>
                          m.id === session.model?.id &&
                          m.providerID === session.model?.providerID,
                      )
                      ?.context?.toLocaleString() || "—"}
                  </dd>
                  <dt>{tr("Сжатия / повторы")}</dt>
                  <dd>
                    {metrics.compactions} / {metrics.retries}
                  </dd>
                  <dt>{tr("Длительность")}</dt>
                  <dd>
                    {session.busy ? elapsed(session) : 0} {tr("с")}
                  </dd>
                </dl>
                <small>
                  {tr("Баланс провайдера недоступен.")}
                  {metrics.partial
                    ? ` ${tr("Данные только из загруженной истории.")}`
                    : ""}
                </small>
                {metrics.errors.map((e, i) => (
                  <small className="rcf-error" key={i}>
                    {e}
                  </small>
                ))}
              </div>
            </details>
          )}
        </div>
      </div>
      {projectPoint && (
        <FloatingPanel
          position={projectPoint}
          close={() => setProjectPoint(undefined)}
          label={tr("Рабочая папка")}
          className="rcf-project-menu"
          role="dialog"
        >
          <strong>{project.name}</strong>
          <code>{session?.directory ?? project.path}</code>
          {currentTree && (
            <small>
              {currentTree.branch}
              {currentTree.dirty ? " · " + tr("есть изменения") : ""}
            </small>
          )}
          {session?.completed && <small>{tr("завершено")}</small>}
          <button
            onClick={() => {
              void attempt(() =>
                api.copyText(session?.directory ?? project.path),
              );
              setProjectPoint(undefined);
            }}
          >
            {tr("Копировать путь")}
          </button>
          <button
            onClick={() => {
              void attempt(() => api.revealProject(project.id));
              setProjectPoint(undefined);
            }}
          >
            {tr("Открыть папку проекта")}
          </button>
          <button onClick={() => show("Worktrees")}>
            {tr("Рабочие копии")}
          </button>
        </FloatingPanel>
      )}
      {open && (
        <Modal
          title={tr("Управление задачей")}
          close={close}
          headerless
          className="history-dialog task-dialog"
          backdropClassName="history-backdrop task-backdrop"
        >
          <div className="rcf-heading">
            <Layers size={16} />
            <div>
              <h2>{tr("Управление задачей")}</h2>
              <p title={session?.directory ?? project.path}>
                {project.name}
                <span> · </span>
                {session?.directory ?? project.path}
              </p>
            </div>
            <IconButton label={tr("Закрыть")} onClick={close}>
              <X size={17} />
            </IconButton>
          </div>
          <div className="rcf-tabbar">
            <div
              className="rcf-tabs"
              role="tablist"
              aria-label={tr("Разделы задачи")}
              onKeyDown={(e) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key))
                  return;
                e.preventDefault();
                const index = tabs.findIndex((t) => t.id === tab);
                const next =
                  e.key === "Home"
                    ? 0
                    : e.key === "End"
                      ? tabs.length - 1
                      : (index +
                          (e.key === "ArrowRight" ? 1 : -1) +
                          tabs.length) %
                        tabs.length;
                setTab(tabs[next].id);
                setPatch(undefined);
                e.currentTarget
                  .querySelectorAll<HTMLButtonElement>('[role="tab"]')
                  [next]?.focus();
              }}
            >
              {tabs.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  id={`task-tab-${id.replaceAll(" ", "-")}`}
                  role="tab"
                  aria-selected={tab === id}
                  aria-controls="task-panel"
                  tabIndex={tab === id ? 0 : -1}
                  onClick={() => {
                    setTab(id);
                    setPatch(undefined);
                  }}
                >
                  <Icon size={14} />
                  {label}
                </button>
              ))}
            </div>
            <IconButton
              label={tr("Обновить сведения о задаче")}
              onClick={() => void run(reload)}
              disabled={busy}
            >
              <RefreshCw size={14} className={busy ? "spin" : ""} />
            </IconButton>
          </div>
          <div
            className="rcf-tools"
            id="task-panel"
            role="tabpanel"
            aria-busy={loading}
            aria-labelledby={`task-tab-${tab.replaceAll(" ", "-")}`}
          >
            {loading && (
              <div className="rcf-loading" role="status">
                <LoaderCircle size={15} className="spin" />
                {tr("Загружаю сведения о задаче…")}
              </div>
            )}
            <div hidden={loading}>
              {tab === "Worktrees" && (
                <>
                  <p className="rcf-intro">
                    {tr(
                      "Рабочая копия — отдельная папка и ветка Git для задачи. Так параллельные изменения не мешают друг другу.",
                    )}
                  </p>
                  {!trees.length ? (
                    <div className="rcf-empty">
                      <GitBranch size={22} />
                      <strong>
                        {tr("Этот проект работает в обычной папке")}
                      </strong>
                      <p>
                        {tr(
                          "Продолжайте задачу здесь. Чтобы создавать отдельные рабочие копии, сначала настройте Git в проекте.",
                        )}
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="rcf-section-heading">
                        <span>{tr("Папки проекта")}</span>
                        <button
                          className="rcf-text-action"
                          aria-expanded={addingTree}
                          onClick={() => setAddingTree(!addingTree)}
                        >
                          <Plus size={13} />
                          {tr("Новая копия")}
                        </button>
                      </div>
                      {addingTree && (
                        <form
                          className="rcf-form rcf-tree-form"
                          onSubmit={(e) => {
                            e.preventDefault();
                            void run(async () => {
                              await api.createWorktree(project.id, branch);
                              setBranch("rcf/");
                              setAddingTree(false);
                            });
                          }}
                        >
                          <label>
                            {tr("Название ветки")}
                            <input
                              autoFocus
                              aria-label={tr("Новая ветка рабочей копии")}
                              value={branch}
                              onChange={(e) => setBranch(e.target.value)}
                              placeholder="rcf/task-name"
                            />
                          </label>
                          <button
                            className="secondary"
                            disabled={
                              busy || !branch.trim() || branch === "rcf/"
                            }
                          >
                            {tr("Создать копию")}
                          </button>
                        </form>
                      )}
                      <div className="rcf-list">
                        {trees.map((tree) => (
                          <div
                            className="rcf-row rcf-tree-row"
                            key={tree.directory}
                          >
                            <GitBranch size={15} />
                            <div className="rcf-row-copy">
                              <strong>
                                {tree.branch}
                                {tree.main && (
                                  <span className="rcf-badge">
                                    {tr("Основная")}
                                  </span>
                                )}
                                {sameDirectory(
                                  tree.directory,
                                  session?.directory,
                                ) && (
                                  <span className="rcf-badge">
                                    {tr("Текущая")}
                                  </span>
                                )}
                              </strong>
                              <code title={tree.directory}>
                                {tree.directory}
                              </code>
                              <small>
                                {tree.dirty
                                  ? tr("Есть локальные файлы или изменения")
                                  : tr("Без изменений")}
                              </small>
                              <div className="rcf-actions">
                                <button
                                  className="rcf-text-action"
                                  disabled={busy}
                                  onClick={() =>
                                    void run(async () =>
                                      enter(
                                        await api.createWorktreeSession(
                                          project.id,
                                          tree.directory,
                                          state.preferences.model,
                                        ),
                                      ),
                                    )
                                  }
                                >
                                  {tr("Новая задача здесь")}
                                </button>
                                {!tree.main && (
                                  <button
                                    className="rcf-text-action"
                                    disabled={busy || tree.dirty || tree.locked}
                                    title={
                                      tree.dirty
                                        ? tr(
                                            "Сначала сохраните или уберите локальные изменения",
                                          )
                                        : undefined
                                    }
                                    onClick={() =>
                                      void run(() =>
                                        api.removeWorktree(
                                          project.id,
                                          tree.directory,
                                        ),
                                      )
                                    }
                                  >
                                    {tr("Убрать копию…")}
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                      <p className="rcf-note">
                        {tr(
                          "При удалении копии ветка Git и история чатов сохраняются.",
                        )}
                      </p>
                    </>
                  )}
                  {session && !session.reviewSourceId && (
                    <div className="rcf-section-end">
                      <button
                        className="secondary"
                        disabled={busy || session.running || session.completed}
                        onClick={() =>
                          void run(async () => {
                            await api.finishTask(session.id);
                            const snapshot = await api.refreshSession(
                              session.id,
                            );
                            useApp.getState().set({ snapshot });
                          })
                        }
                      >
                        {session.completed
                          ? tr("Задача завершена")
                          : tr("Завершить задачу")}
                      </button>
                      <small>{tr("Рабочая папка и история сохранятся.")}</small>
                    </div>
                  )}
                </>
              )}
              {tab === "Agent Control" && (
                <>
                  <p className="rcf-intro">
                    {tr(
                      "Поручите помощнику отдельную часть задачи. Здесь появятся его ход работы и результат, а основная переписка останется у вас.",
                    )}
                  </p>
                  {!sourceId ? (
                    <p className="rcf-note">
                      {tr(
                        "Сначала создайте задачу, чтобы подключить помощника.",
                      )}
                    </p>
                  ) : (
                    <>
                      <div className="rcf-section-heading">
                        <span>
                          {tr("Помощники задачи")}
                          {runs.length > 0 && ` · ${runs.length}`}
                        </span>
                        <button
                          className="rcf-text-action"
                          aria-expanded={addingAgent}
                          onClick={() => setAddingAgent(!addingAgent)}
                        >
                          {addingAgent ? <X size={13} /> : <Plus size={13} />}
                          {addingAgent
                            ? tr("Свернуть")
                            : tr("Добавить помощника")}
                        </button>
                      </div>
                      {addingAgent && (
                        <form
                          className="rcf-form rcf-agent-form"
                          onSubmit={(e) => {
                            e.preventDefault();
                            void run(async () => {
                              await api.launchAgent(
                                sourceId,
                                agent,
                                task,
                                model
                                  ? {
                                      id: model.id,
                                      providerID: model.providerID,
                                    }
                                  : undefined,
                                directory || undefined,
                              );
                              setTask("");
                              setAddingAgent(false);
                            });
                          }}
                        >
                          <label className="rcf-task-input">
                            {tr("Что поручить помощнику?")}
                            <textarea
                              autoFocus
                              aria-label={tr("Задача помощника")}
                              value={task}
                              onChange={(e) => setTask(e.target.value)}
                              rows={3}
                              placeholder={tr(
                                "Например, найдите причину ошибки и предложите решение…",
                              )}
                              required
                            />
                          </label>
                          <div className="rcf-form-columns">
                            <label>
                              {tr("Роль")}
                              <CustomSelect
                                aria-label={tr("Роль помощника")}
                                value={agent}
                                onChange={(value) => {
                                  setAgent(value);
                                  setDirectory("");
                                }}
                                options={definitions
                                  .filter((a) => a.id !== "rcf-reviewer")
                                  .map((a) => ({ value: a.id, label: agentName(a.id) }))}
                              />
                            </label>
                            <label>
                              {tr("Рабочая папка")}
                              <CustomSelect
                                aria-label={tr("Папка помощника")}
                                value={directory}
                                onChange={setDirectory}
                                options={[
                                  { value: "", label: reader
                                    ? tr("Текущая папка · только чтение")
                                    : tr("Выберите отдельную копию") },
                                  ...availableTrees.map((t) => ({ value: t.directory, label: t.branch })),
                                ]}
                              />
                            </label>
                          </div>
                          <p className="rcf-role-hint">
                            {reader
                              ? tr(
                                  "Исследователь читает файлы и ищет по проекту. Он не меняет файлы и не запускает команды.",
                                )
                              : tr(
                                  "Этот помощник может менять файлы. Он работает в отдельной копии; действия с ограниченным доступом требуют подтверждения.",
                                )}
                          </p>
                          {!reader && !availableTrees.length && (
                            <button
                              type="button"
                              className="rcf-text-action"
                              onClick={() => {
                                setTab("Worktrees");
                                setAddingTree(true);
                              }}
                            >
                              {tr("Создать отдельную рабочую копию")}
                            </button>
                          )}
                          <details className="rcf-advanced">
                            <summary>{tr("Модель и сведения о роли")}</summary>
                            <label>
                              {tr("Модель")}
                              <CustomSelect
                                aria-label={tr("Модель помощника")}
                                value={selectedModel}
                                onChange={setSelectedModel}
                                options={models()}
                              />
                            </label>
                            <p className="rcf-note">
                              {
                                definitions.find((a) => a.id === agent)
                                  ?.description
                              }
                            </p>
                            <code>{agent}</code>
                          </details>
                          <div className="rcf-actions">
                            <button
                              className="primary"
                              disabled={
                                busy ||
                                !task.trim() ||
                                !definitions.some((a) => a.id === agent) ||
                                (!reader &&
                                  !availableTrees.some((t) =>
                                    sameDirectory(t.directory, directory),
                                  ))
                              }
                            >
                              {tr("Запустить помощника")}
                            </button>
                            <button
                              type="button"
                              className="rcf-text-action"
                              onClick={() => setAddingAgent(false)}
                            >
                              {tr("Отмена")}
                            </button>
                          </div>
                        </form>
                      )}
                      {!runs.length && !addingAgent && (
                        <div className="rcf-empty">
                          <Users size={23} />
                          <strong>{tr("Помощников пока нет")}</strong>
                          <p>
                            {tr(
                              "Начните с исследователя: он изучит проект без изменения файлов. Для разработки выберите отдельную рабочую копию.",
                            )}
                          </p>
                        </div>
                      )}
                      <div className="rcf-list">
                        {runs.map((child) => (
                          <details
                            className="rcf-row rcf-agent-row"
                            key={child.session.id}
                          >
                            <summary>
                              <span
                                className={`rcf-state-dot ${child.status.toLowerCase()}`}
                              />
                              <span className="rcf-agent-summary">
                                <strong>{agentName(child.agent)}</strong>
                                <span>
                                  {child.session.reviewSourceId
                                    ? tr("Независимая проверка изменений")
                                    : child.task || child.session.title}
                                </span>
                              </span>
                              <span className="rcf-status">
                                {statusName(child.status)}
                              </span>
                            </summary>
                            <div className="rcf-agent-detail">
                              <p>
                                {child.session.reviewSourceId
                                  ? tr("Независимая проверка изменений")
                                  : child.task}
                              </p>
                              <small>
                                {child.session.model?.id ?? tr("По умолчанию")}{" "}
                                · {elapsed(child.session)} {tr("с")}
                              </small>
                              {child.actions.length > 0 && (
                                <p className="rcf-note">
                                  {child.actions.join(" · ")}
                                </p>
                              )}
                              <pre>
                                {child.result ||
                                  tr("Результат появится после выполнения.")}
                              </pre>
                              <details className="rcf-advanced">
                                <summary>{tr("Технические сведения")}</summary>
                                <code>
                                  {tr("Основная задача")}:{" "}
                                  {child.session.parentId ??
                                    child.session.reviewSourceId}
                                  <br />
                                  {tr("Помощник")}: {child.session.id}
                                  <br />
                                  {child.session.directory}
                                  <br />
                                  {child.session.model?.providerID}/
                                  {child.session.model?.id}
                                  <br />
                                  {child.agent}
                                </code>
                              </details>
                              <div className="rcf-actions">
                                <button
                                  className="secondary"
                                  onClick={() =>
                                    void attempt(() => enter(child.session))
                                  }
                                >
                                  {tr("Открыть переписку")}
                                </button>
                                {child.session.running && (
                                  <button
                                    className="secondary"
                                    disabled={busy}
                                    onClick={() =>
                                      void run(() => api.stop(child.session.id))
                                    }
                                  >
                                    <Square size={12} />
                                    {tr("Остановить")}
                                  </button>
                                )}
                              </div>
                            </div>
                          </details>
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}
              {tab === "Code Review" && (
                <>
                  <p className="rcf-intro">
                    {tr(
                      "Независимый агент проверит изменения и предложит исправления. Он получает различия файлов и сеанса без доступа к инструментам и редактированию.",
                    )}
                  </p>
                  <p className="rcf-note">
                    {tr(
                      "Полный контекст исходного кода и результаты тестов могут быть недоступны.",
                    )}
                  </p>
                  <div className="rcf-form rcf-review-form">
                    <label>
                      {tr("Модель для проверки")}
                      <CustomSelect
                        aria-label={tr("Модель рецензента")}
                        value={selectedModel}
                        onChange={setSelectedModel}
                        options={models(tr("Выберите модель"))}
                      />
                    </label>
                    <button
                      className="primary"
                      disabled={
                        busy || !sourceId || !model || !!session?.running
                      }
                      onClick={() =>
                        void run(async () => {
                          const next = await api.startReview(sourceId!, {
                            id: model!.id,
                            providerID: model!.providerID,
                          });
                          setReview(await api.reviewReport(next.id));
                        })
                      }
                    >
                      {tr("Проверить изменения")}
                    </button>
                  </div>
                  {review && (
                    <div className="rcf-review-report">
                      <div className="rcf-section-heading">
                        <strong>{tr("Результат проверки")}</strong>
                        <span>{statusName(review.status)}</span>
                      </div>
                      {review.stale && (
                        <p className="rcf-warning">
                          {tr(
                            "Код изменился после проверки. Запустите её повторно перед исправлениями.",
                          )}
                        </p>
                      )}
                      {review.issues ? (
                        <>
                          <div className="rcf-review-counts">
                            {tr("Критические")}:{" "}
                            {
                              review.issues.filter(
                                (i) => i.severity === "critical",
                              ).length
                            }
                            <span>·</span>
                            {tr("Серьёзные")}:{" "}
                            {
                              review.issues.filter(
                                (i) => i.severity === "major",
                              ).length
                            }
                            <span>·</span>
                            {tr("Небольшие")}:{" "}
                            {
                              review.issues.filter(
                                (i) => i.severity === "minor",
                              ).length
                            }
                          </div>
                          <p className="rcf-note">
                            {tr("Тесты")}: {review.tests ?? tr("Нет данных")}
                          </p>
                          {review.issues.map((issue, i) => (
                            <article key={i}>
                              <strong>
                                {
                                  {
                                    critical: tr("Критическая"),
                                    major: tr("Серьёзная"),
                                    minor: tr("Небольшая"),
                                  }[issue.severity]
                                }{" "}
                                · {issue.file}
                                {issue.line ? `:${issue.line}` : ""}
                              </strong>
                              <p>{issue.description}</p>
                              <p className="rcf-note">{issue.rationale}</p>
                              <p>{issue.fix}</p>
                            </article>
                          ))}
                        </>
                      ) : (
                        <p className="rcf-note">
                          {tr("Число замечаний пока неизвестно.")}
                        </p>
                      )}
                      <ul className="rcf-note">
                        {review.limitations.map((l, i) => (
                          <li key={i}>{l}</li>
                        ))}
                      </ul>
                      <details className="rcf-advanced">
                        <summary>{tr("Полный ответ рецензента")}</summary>
                        <pre>{review.raw}</pre>
                      </details>
                      <div className="rcf-actions">
                        <button
                          className="secondary"
                          disabled={
                            busy ||
                            review.status !== "Completed" ||
                            !review.issues?.length ||
                            review.stale
                          }
                          onClick={() =>
                            void run(() => api.fixReview(review.sessionId))
                          }
                        >
                          {tr("Исправить замечания…")}
                        </button>
                        <button
                          className="rcf-text-action"
                          onClick={() =>
                            void attempt(async () =>
                              enter(
                                (await api.openSession(review.sessionId))
                                  .session,
                              ),
                            )
                          }
                        >
                          {tr("Открыть переписку рецензента")}
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
              {tab === "Checkpoints" && (
                <>
                  <p className="rcf-intro">
                    {tr(
                      "Вернитесь к одному из своих сообщений и продолжите разговор с этого места.",
                    )}
                  </p>
                  <p className="rcf-note">
                    {tr(
                      "Восстанавливается только переписка. Файлы проекта, коммиты Git и локальные изменения сохраняются.",
                    )}
                  </p>
                  <div className="rcf-section-heading">
                    <span>{tr("Сообщения задачи")}</span>
                    <button
                      className="rcf-text-action"
                      disabled={busy || !sourceId}
                      onClick={() =>
                        void run(async () => {
                          const diffs = await api.sessionDiff(sourceId!);
                          setPatch(diffs.map((d) => d.patch).join("\n"));
                        })
                      }
                    >
                      {tr("Изменения задачи")}
                    </button>
                  </div>
                  {!points.length && (
                    <p className="rcf-note">
                      {tr("Здесь появятся отправленные сообщения.")}
                    </p>
                  )}
                  <div className="rcf-list">
                    {points.map((point) => (
                      <div
                        className="rcf-row rcf-history-row"
                        key={point.messageId}
                      >
                        <time>{new Date(point.at).toLocaleString()}</time>
                        <p>{point.title}</p>
                        {point.files.length > 0 && (
                          <details className="rcf-advanced">
                            <summary>{tr("Связанные файлы")}</summary>
                            <code>{point.files.join("\n")}</code>
                          </details>
                        )}
                        <button
                          className="rcf-text-action"
                          disabled={busy || !sourceId || session?.running}
                          onClick={() =>
                            void run(async () => {
                              if (
                                await api.restoreCheckpoint(
                                  sourceId!,
                                  point.messageId,
                                )
                              )
                                await openSession(
                                  (await api.openSession(sourceId!)).session,
                                );
                            })
                          }
                        >
                          {tr("Продолжить отсюда…")}
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {patch !== undefined && <DiffViewer patch={patch} />}
            </div>
          </div>
          <div className="rcf-footer">
            <span role="status">{busy ? tr("Обновление…") : ""}</span>
            <span>
              <kbd>Esc</kbd> {tr("закрыть")}
            </span>
          </div>
        </Modal>
      )}
    </>
  );
}
