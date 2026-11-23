import { tr, useLanguage, trf } from "./i18n";
import { BrandIcon } from "./BrandIcon";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Archive,
  ChevronRight,
  FolderOpen,
  Search,
  Unplug,
  X,
} from "lucide-react";
import type { Preferences, Project } from "../shared/types";
import {
  api,
  attempt,
  report,
  savePreferences,
  selectProject,
  useApp,
} from "./store";
import { IconButton } from "./components";
import { AppearanceSettings } from "./AppearanceSettings";
import { CustomSelect } from "./CustomSelect";
import { ModelSettings } from "./ModelSettings";
import { PermissionSettings } from "./PermissionSettings";
import {
  SettingRow,
  Toggle,
  SettingsGroup,
  SettingsDisclosure,
  SettingsHeading,
  SettingsConfirmation,
  SettingsMessage,
} from "./SettingsControls";
import {
  categories,
  navigationGroups,
  parameters,
  type Category,
  type Parameter,
} from "./settings-index";
import { MemorySettings } from "./MemorySettings";
import { EngineSettings } from "./EngineSettings";
import "./settings.css";

const shortcuts = [
  ["Глобальный поиск", "Ctrl", "K"],
  ["Новый чат", "Ctrl", "N"],
  ["Открыть настройки", "Ctrl", ","],
  ["Боковая панель", "Ctrl", "B"],
  ["Переименовать чат", "Ctrl", "Alt", "R"],
  ["Закрепить чат", "Ctrl", "Alt", "P"],
  ["Отметить прочитанным / непрочитанным", "Ctrl", "Shift", "U"],
  ["Архивировать чат", "Ctrl", "Shift", "A"],
  ["Отправить сообщение", "Enter"],
  ["Новая строка в сообщении", "Shift", "Enter"],
  ["Закрыть меню или диалог", "Esc"],
];

export function Settings({
  close = () => useApp.getState().set({ settings: false }),
}: {
  close?: () => void;
}) {
  useLanguage();

  const {
    engine,
    preferences,
    projects: allProjects,
    snapshot,
    settingsSection,
  } = useApp();
  const projects = allProjects.filter((p) => !p.managed);
  const [tab, setTab] = useState<Category>(
    () =>
      categories.find((item) => item.id === useApp.getState().settingsSection)
        ?.id ?? "general",
  );
  useEffect(() => {
    if (!settingsSection) return;
    const requested = categories.find((item) => item.id === settingsSection);
    if (requested) {
      setTab(requested.id);
      setQuery("");
      setTarget("");
    }
    useApp.getState().set({ settingsSection: undefined });
  }, [settingsSection]);
  const [query, setQuery] = useState("");
  const [shortcutQuery, setShortcutQuery] = useState("");
  const [target, setTarget] = useState("");
  const [confirm, setConfirm] = useState<"restart" | "full" | Project>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const resultList = useRef<HTMLDivElement>(null);
  const category = categories.find((item) => item.id === tab)!;
  const normalized = query.trim().toLocaleLowerCase("ru");
  const results = parameters.filter((item) =>
    `${tr(item.title)} ${tr(item.description)} ${item.title} ${item.description} ${item.keywords ?? ""}`
      .toLocaleLowerCase("ru")
      .includes(normalized),
  );
  useEffect(() => {
    search.current?.focus();
  }, []);
  useEffect(() => {
    if (normalized || !target) {
      scroll.current?.scrollTo({ top: 0 });
      return;
    }
    const element = document.getElementById(`setting-${target}`);
    let parent = element?.parentElement;
    while (parent) {
      if (parent instanceof HTMLDetailsElement) parent.open = true;
      parent = parent.parentElement;
    }
    if (element instanceof HTMLDetailsElement) element.open = true;
    element?.scrollIntoView({ block: "center" });
    const focusTarget =
      element instanceof HTMLDetailsElement && !element.hasAttribute("tabindex")
        ? element.querySelector("summary")
        : element;
    focusTarget?.focus({ preventScroll: true });
  }, [tab, target, normalized]);
  async function update(value: Partial<Preferences>) {
    try {
      await savePreferences(value);
    } catch (error) {
      report(error);
    }
  }
  async function runConfirmation() {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm === "restart") await api.retryEngine();
      else if (confirm === "full") await savePreferences({ mode: "full" });
      else {
        await api.removeProject(confirm.id);
        const state = useApp.getState();
        const next = state.projects.filter((item) => item.id !== confirm.id);
        state.set({
          projects: next,
          sessions: state.sessions.filter(
            (item) => item.projectId !== confirm.id,
          ),
        });
        if (state.preferences.projectId === confirm.id) {
          state.set({ snapshot: undefined });
          await savePreferences({
            projectId: next[0]?.id,
            sessionId: undefined,
          });
        }
      }
      setConfirm(undefined);
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  }
  function navigate(item: Parameter) {
    setTab(item.category);
    setQuery("");
    setTarget(item.id);
  }
  function openArchive() {
    close();
    window.dispatchEvent(new CustomEvent("forge:open-archive"));
  }
  const engineLabel = {
    ready: tr("Подключён"),
    starting: tr("Запускается"),
    reconnecting: tr("Восстанавливает подключение"),
    error: tr("Ошибка подключения"),
    stopped: tr("Остановлен"),
  }[engine.state];
  const shortcutGroups = [
    { title: tr("Навигация и чаты"), rows: shortcuts.slice(0, 8) },
    { title: tr("Сообщения"), rows: shortcuts.slice(8, 10) },
    { title: tr("Меню"), rows: shortcuts.slice(10) },
  ]
    .map(({ title, rows }) => ({
      title,
      rows: rows.filter(([label, ...keys]) =>
        `${tr(label)} ${keys.join(" ")}`
          .toLocaleLowerCase("ru")
          .includes(shortcutQuery.trim().toLocaleLowerCase("ru")),
      ),
    }))
    .filter(({ rows }) => rows.length);
  return (
    <section
      className="settings-screen"
      aria-label={tr("Настройки")}
      onKeyDown={(event) => {
        if ((event.target as HTMLElement).closest('[role="dialog"]')) return;
        if (event.key === "Escape" && !confirm) {
          event.stopPropagation();
          if (query) {
            setQuery("");
            search.current?.focus();
          } else close();
        }
      }}
    >
      <nav className="settings-sidebar" aria-label={tr("Категории настроек")}>
        <button className="settings-back" onClick={close}>
          <ArrowLeft size={16} />
          {tr("Вернуться к чату")}
        </button>
        <div className="settings-sidebar-brand">
          <BrandIcon />
          <h1>{tr("Настройки")}</h1>
        </div>
        <div className="search-input settings-search">
          <Search size={15} />
          <input
            ref={search}
            value={query}
            aria-label={tr("Поиск по параметрам")}
            placeholder={tr("Поиск по параметрам…")}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (!normalized || event.nativeEvent.isComposing) return;
              const first =
                resultList.current?.querySelector<HTMLButtonElement>("button");
              if (event.key === "ArrowDown" && first) {
                event.preventDefault();
                first.focus();
              } else if (event.key === "Enter" && first && results.length) {
                event.preventDefault();
                first.click();
              }
            }}
          />
          {query && (
            <IconButton
              label={tr("Очистить поиск параметров")}
              onClick={() => {
                setQuery("");
                search.current?.focus();
              }}
            >
              <X size={13} />
            </IconButton>
          )}
        </div>
        <div className="settings-category-list">
          {navigationGroups.map(({ title, sections }, index) => (
            <div
              className="settings-nav-group"
              key={title}
              role="group"
              aria-labelledby={`settings-nav-${index}`}
            >
              <h2 id={`settings-nav-${index}`}>{tr(title)}</h2>
              {sections.map((id) => {
                const item = categories.find((category) => category.id === id)!;
                const active = tab === item.id && !normalized;
                return (
                  <button
                    key={item.id}
                    className={active ? "selected" : ""}
                    aria-current={active ? "page" : undefined}
                    onClick={() => {
                      setTab(item.id);
                      setQuery("");
                      setTarget("");
                      scroll.current?.scrollTo({ top: 0 });
                    }}
                  >
                    <item.icon size={16} aria-hidden="true" />
                    <span>{tr(item.title)}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="settings-sidebar-footer">
          <span className={`status-dot ${engine.state}`} />
          OpenCode · {engineLabel}
          <small>Rote Coding Fraktion 0.2.3</small>
        </div>
      </nav>
      <div className="settings-content" ref={scroll}>
        <div className="settings-page-body">
          <SettingsHeading
            title={normalized ? tr("Результаты поиска") : tr(category.title)}
            description={
              normalized
                ? trf`Параметры по запросу «${query.trim()}»`
                : tr(category.description)
            }
            close={close}
          />
          {normalized ? (
            <div
              className="settings-results"
              aria-live="polite"
              ref={resultList}
            >
              {results.length ? (
                results.map((item) => (
                  <button key={item.id} onClick={() => navigate(item)}>
                    <div>
                      <strong>{tr(item.title)}</strong>
                      <p>{tr(item.description)}</p>
                      <small>
                        {tr(
                          categories.find((entry) => entry.id === item.category)
                            ?.title ?? "",
                        )}
                      </small>
                    </div>
                    <ChevronRight size={16} />
                  </button>
                ))
              ) : (
                <div className="settings-empty">
                  <Search size={25} />
                  <h3>{tr("Параметры не найдены")}</h3>
                  <p>
                    {tr("Попробуйте «шрифт», «ключ», «память» или «проект».")}
                  </p>
                  <button className="secondary" onClick={() => setQuery("")}>
                    {tr("Показать все настройки")}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <>
              {tab === "general" && (
                <>
                  <SettingsGroup title={tr("Приложение")}>
                    <SettingRow
                      id="language"
                      title={tr("Язык приложения")}
                      description={tr(
                        "Язык интерфейса. Названия проектов и переписка сохраняются без изменений.",
                      )}
                    >
                      <CustomSelect
                        aria-labelledby="label-language"
                        value={preferences.language ?? "ru"}
                        onChange={(value) =>
                          void update({
                            language: value as "ru" | "en",
                          })
                        }
                        options={[
                          { value: "ru", label: tr("Русский") },
                          { value: "en", label: "English" },
                        ]}
                      />
                    </SettingRow>
                    <SettingsDisclosure
                      id="lifecycle"
                      title={tr("Завершение и восстановление")}
                    >
                      <p>
                        {tr(
                          "При запуске восстанавливаются сохранённые проекты, настройки и последний доступный чат. Закрытие приложения останавливает локальный движок и его задачи; история сохраняется.",
                        )}
                      </p>
                      <p className="hint">
                        {tr(
                          "Автозапуск, работа в системном трее и выбор терминала пока не поддерживаются.",
                        )}
                      </p>
                    </SettingsDisclosure>
                  </SettingsGroup>
                  <SettingsGroup title={tr("Рабочее пространство")}>
                    <SettingRow
                      id="project"
                      title={tr("Текущий проект")}
                      description={tr(
                        "Рабочая папка для новых чатов. Существующая переписка остаётся в своём проекте.",
                      )}
                    >
                      <CustomSelect
                        aria-labelledby="label-project"
                        value={
                          projects.some((p) => p.id === preferences.projectId)
                            ? preferences.projectId ?? ""
                            : ""
                        }
                        disabled={!projects.length}
                        onChange={(value) => {
                          const project = projects.find(
                            (item) => item.id === value,
                          );
                          if (project)
                            void attempt(() => selectProject(project));
                        }}
                        options={[
                          { value: "", label: tr("Выберите проект"), disabled: true },
                          ...projects.map((item) => ({ value: item.id, label: item.name })),
                        ]}
                      />
                    </SettingRow>
                    <div
                      className="settings-group"
                      id="setting-projects"
                      tabIndex={-1}
                    >
                      <h3>{tr("Проекты")}</h3>
                      {projects.length ? (
                        projects.map((project) => (
                          <div className="settings-project" key={project.id}>
                            <FolderOpen size={16} />
                            <span>
                              {project.name}
                              <small>{project.path}</small>
                            </span>
                            <IconButton
                              label={trf`Открыть папку ${project.name}`}
                              onClick={() =>
                                void attempt(() =>
                                  api.revealProject(project.id),
                                )
                              }
                            >
                              <ArrowUpRight size={15} />
                            </IconButton>
                            <IconButton
                              label={trf`Убрать ${project.name} из списка`}
                              onClick={() => setConfirm(project)}
                            >
                              <Unplug size={15} />
                            </IconButton>
                          </div>
                        ))
                      ) : (
                        <p className="hint">
                          {tr(
                            "Откройте папку через «Новый проект» в боковой панели, чтобы начать работу.",
                          )}
                        </p>
                      )}
                      <p className="hint">
                        {tr(
                          "Удаление из списка сохраняет папку проекта и историю OpenCode.",
                        )}
                      </p>
                    </div>
                  </SettingsGroup>
                </>
              )}
              {tab === "appearance" && <AppearanceSettings />}
              {tab === "connections" && <ModelSettings />}
              {tab === "permissions" && (
                <PermissionSettings
                  mode={preferences.mode}
                  onChange={(mode) => {
                    if (mode === "full") setConfirm("full");
                    else void update({ mode });
                  }}
                />
              )}
              {tab === "memory" && (
                <MemorySettings
                  onEnabledChange={(memoryEnabled) =>
                    void update({ memoryEnabled })
                  }
                />
              )}
              {tab === "history" && (
                <>
                  <SettingsGroup title={tr("Переписка")}>
                    <SettingRow
                      id="archive"
                      title={tr("Архив чатов")}
                      description={tr(
                        "Архив скрывает переписку из боковой панели. Чаты можно восстановить.",
                      )}
                    >
                      <button className="secondary" onClick={openArchive}>
                        <Archive size={14} />
                        {tr("Открыть архив")}
                      </button>
                    </SettingRow>
                    <SettingRow
                      id="export"
                      title={tr("Копировать переписку")}
                      description={
                        snapshot
                          ? trf`Текст чата «${snapshot.session.title}» будет скопирован в буфер обмена.`
                          : tr("Откройте чат, чтобы скопировать его текст.")
                      }
                    >
                      <button
                        className="secondary"
                        disabled={!snapshot}
                        onClick={() =>
                          void attempt(async () => {
                            if (!snapshot) return;
                            await api.copySession(snapshot.session.id, "text");
                            setNotice(
                              tr("Переписка скопирована в буфер обмена"),
                            );
                          })
                        }
                      >
                        {tr("Копировать текст")}
                      </button>
                    </SettingRow>
                    {notice && (
                      <SettingsMessage kind="success">{notice}</SettingsMessage>
                    )}
                  </SettingsGroup>
                  <SettingsDisclosure
                    id="storage"
                    title={tr("Хранение данных")}
                  >
                    <p>
                      {tr(
                        "Историю и результаты инструментов хранит локальный OpenCode. Проекты, настройки интерфейса и закреплённые модели сохраняются в данных Rote Coding Fraktion. Ключи провайдеров находятся в хранилище учётных данных движка.",
                      )}
                    </p>
                    <p className="hint">
                      {tr(
                        "Очистка истории и кеша здесь не выполняется. Удаление проекта из списка сохраняет его файлы.",
                      )}
                    </p>
                  </SettingsDisclosure>
                </>
              )}
              {tab === "shortcuts" && (
                <div
                  id="setting-shortcuts"
                  tabIndex={-1}
                  className="settings-shortcuts"
                >
                  <div className="search-input">
                    <Search size={14} />
                    <input
                      aria-label={tr("Найти сочетание клавиш")}
                      placeholder={tr("Поиск…")}
                      value={shortcutQuery}
                      onChange={(e) => setShortcutQuery(e.target.value)}
                    />
                  </div>
                  {shortcutGroups.map(({ title, rows }) => (
                    <section className="settings-shortcut-group" key={title}>
                      <h3>{title}</h3>
                      {rows.map(([label, ...keys]) => (
                        <div key={label}>
                          <span>{tr(label)}</span>
                          <span>
                            {keys.map((key) => (
                              <kbd key={key}>{key}</kbd>
                            ))}
                          </span>
                        </div>
                      ))}
                    </section>
                  ))}
                  {!shortcutGroups.length && (
                    <p className="hint" role="status">
                      {tr("Сочетания не найдены")}
                    </p>
                  )}
                </div>
              )}
              {tab === "about" && (
                <>
                  <div
                    className="settings-about-brand"
                    id="setting-version"
                    tabIndex={-1}
                  >
                    <BrandIcon className="settings-brand-mark" />
                    <div>
                      <h3>Rote Coding Fraktion</h3>
                      <p>
                        {tr("Версия 0.2.3 · локальная среда для работы с ИИ")}
                      </p>
                    </div>
                  </div>
                  <EngineSettings connection={engineLabel} restart={() => setConfirm("restart")} />
                  <SettingsDisclosure
                    id="licenses"
                    title={tr("Компоненты и лицензии")}
                  >
                    <p>
                      {tr(
                        "Rote Coding Fraktion распространяется по лицензии MIT. Приложение использует Electron, React и OpenCode. Сведения о сторонних компонентах поставляются в THIRD_PARTY_NOTICES.md.",
                      )}
                    </p>
                    <button
                      className="text-button"
                      onClick={() =>
                        void attempt(() =>
                          api.openExternal("https://opencode.ai/docs/"),
                        )
                      }
                    >
                      {tr("Документация OpenCode")}
                      <ArrowUpRight size={13} />
                    </button>
                    <button
                      className="text-button"
                      onClick={() =>
                        void attempt(() =>
                          api.openExternal(
                            "https://github.com/anomalyco/opencode",
                          ),
                        )
                      }
                    >
                      {tr("Исходный код OpenCode")}
                      <ArrowUpRight size={13} />
                    </button>
                  </SettingsDisclosure>
                </>
              )}
            </>
          )}
        </div>
      </div>
      {confirm && (
        <SettingsConfirmation
          busy={busy}
          destructive={typeof confirm === "object"}
          close={() => setConfirm(undefined)}
          confirm={() => void runConfirmation()}
          action={
            busy
              ? tr("Применение…")
              : confirm === "restart"
                ? tr("Перезапустить")
                : confirm === "full"
                  ? tr("Включить")
                  : tr("Убрать из списка")
          }
          title={
            confirm === "restart"
              ? tr("Перезапустить движок?")
              : confirm === "full"
                ? tr("Включить Full Access?")
                : tr("Убрать проект из списка?")
          }
        >
          <p>
            {confirm === "restart"
              ? tr(
                  "Выполняющиеся задачи будут прерваны. Сохранённая история и проекты останутся доступны.",
                )
              : confirm === "full"
                ? tr(
                    "Агент сможет выполнять команды и изменять файлы без отдельных подтверждений. Используйте для доверенных задач Work Faction.",
                  )
                : trf`Проект «${confirm.name}» исчезнет из списка. Папка и история OpenCode сохранятся.`}
          </p>
        </SettingsConfirmation>
      )}
    </section>
  );
}
