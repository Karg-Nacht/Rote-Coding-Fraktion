import { tr, useLanguage } from "./i18n";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  ChevronRight,
  ExternalLink,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import type { Integration, OAuthAttempt, ProviderModel } from "../shared/types";
import { omniRouteBaseUrl } from "../shared/provider-url";
import { api, attempt, refreshModels, report, useApp } from "./store";
import { IconButton } from "./components";
import { defaults, Fields, type Answers } from "./Fields";
import { CustomSelect } from "./CustomSelect";
import { SettingsGroup, SettingsMessage } from "./SettingsControls";

const pageSize = 24;
const authMethods: Record<string, string> = {
  key: "API key",
  oauth: "OAuth",
  external: "External",
  cli: "CLI",
  env: "Переменная среды",
};
const presets = [
  {
    name: "OmniRoute",
    id: "omniroute",
    baseUrl: "http://localhost:20128/v1",
    runtime: "compatible" as const,
    hint: "provider/model или combo ID",
    preset: "omniroute" as const,
  },
  {
    name: "OpenRouter",
    id: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    runtime: "openrouter" as const,
    hint: "provider/model-id",
  },
  {
    name: "OpenAI",
    id: "openai",
    baseUrl: "https://api.openai.com/v1",
    runtime: "openai" as const,
    hint: "Точный ID модели",
  },
  {
    name: "Anthropic",
    id: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    runtime: "anthropic" as const,
    hint: "Точный ID модели",
  },
  {
    name: "Ollama",
    id: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    runtime: "compatible" as const,
    hint: "Имя установленной модели",
  },
  {
    name: "LM Studio",
    id: "lmstudio",
    baseUrl: "http://127.0.0.1:1234/v1",
    runtime: "compatible" as const,
    hint: "ID загруженной модели",
  },
];
type Custom = {
  name: string;
  id: string;
  baseUrl: string;
  runtime: "compatible" | "openai" | "anthropic" | "openrouter";
  hint?: string;
  preset?: "omniroute";
  configured?: boolean;
};
export function ConnectionsSettings() {
  useLanguage();

  const { engine, preferences } = useApp();
  const [integrations, setIntegrations] = useState<Integration[]>();
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Integration>();
  const [methodIndex, setMethodIndex] = useState(0);
  const [secret, setSecret] = useState("");
  const [values, setValues] = useState<Answers>({});
  const [oauth, setOauth] = useState<OAuthAttempt>();
  const [code, setCode] = useState("");
  const [custom, setCustom] = useState<Custom>();
  const [model, setModel] = useState("");
  const [tools, setTools] = useState(true);
  const [images, setImages] = useState(false);
  const [success, setSuccess] = useState("");
  const [catalog, setCatalog] = useState<ProviderModel[]>();
  const [catalogBusy, setCatalogBusy] = useState(false);
  const catalogRequest = useRef(0);
  const picker = useRef<HTMLDivElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const formHeading = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const formOpen = !!(selected || custom);
  const connected = integrations?.filter(
    (integration) => integration.connected || integration.custom,
  );

  useEffect(() => {
    if (formOpen) formHeading.current?.focus();
    else {
      returnFocus.current?.focus();
      returnFocus.current = null;
    }
  }, [formOpen, selected?.id]);
  useEffect(
    () => () => {
      catalogRequest.current++;
    },
    [],
  );
  function clearCatalog() {
    catalogRequest.current++;
    setCatalog(undefined);
    setCatalogBusy(false);
  }
  async function loadCatalog() {
    if (!custom) return;
    const request = ++catalogRequest.current;
    setCatalogBusy(true);
    try {
      const result = await api.providerModels({
        baseUrl: omniRouteBaseUrl(custom.baseUrl),
        key: secret || undefined,
        providerId: custom.configured ? custom.id : undefined,
      });
      if (catalogRequest.current === request) setCatalog(result);
    } catch (error) {
      if (catalogRequest.current === request) report(error);
    } finally {
      if (catalogRequest.current === request) setCatalogBusy(false);
    }
  }
  async function choosePreset(preset: Custom, source: HTMLElement) {
    setBusy(true);
    try {
      const saved = await api.customProviderSettings(preset.id);
      returnFocus.current = source;
      setCustom({ ...preset, ...saved, configured: !!saved });
      setModel("");
      setSecret("");
      setSuccess("");
      clearCatalog();
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  }
  const projectId = preferences.projectId;
  const reload = useCallback(async () => {
    const integrations = await api.integrations(projectId);
    setIntegrations(integrations);
    await refreshModels(projectId);
  }, [projectId]);
  useEffect(() => {
    if (engine.state === "ready") void attempt(reload);
  }, [engine.state, reload]);
  useEffect(() => {
    if (!oauth || !selected) return;
    let active = true;
    const timer = setInterval(() => {
      void api
        .oauthStatus(selected.id, oauth.attemptID, projectId)
        .then((status) => {
          if (!active) return;
          if (status.status === "complete") {
            setOauth(undefined);
            setSelected(undefined);
            setSuccess(tr("Подключение сохранено"));
            void attempt(reload);
          } else if (
            status.status === "failed" ||
            status.status === "expired"
          ) {
            setOauth(undefined);
            report(status.message ?? tr("Время авторизации истекло."));
          }
        })
        .catch(report);
    }, 1500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [oauth, selected, projectId, reload]);
  const choose = (integration: Integration, source?: HTMLElement) => {
    if (source) returnFocus.current = source;
    setSelected(integration);
    setCustom(undefined);
    setMethodIndex(0);
    setValues(defaults(integration.methods[0]?.form ?? []));
    setSecret("");
    setCode("");
    setSuccess("");
  };
  function openProvider(integration: Integration, source: HTMLElement) {
    if (!integration.custom) {
      choose(integration, source);
      return;
    }
    const preset = presets.find((item) => item.id === integration.id);
    void choosePreset(
      preset ?? {
        id: integration.id,
        name: integration.name,
        baseUrl: "",
        runtime: "compatible",
      },
      source,
    );
  }
  function fromPicker(choose: (source: HTMLButtonElement) => void) {
    if (!addButton.current) return;
    picker.current?.hidePopover();
    choose(addButton.current);
  }
  async function connect() {
    if (!selected) return;
    const method = selected.methods[methodIndex];
    setBusy(true);
    try {
      if (method.type === "key") {
        await api.connectKey(selected.id, secret, values, projectId);
        setSecret("");
        setSelected(undefined);
        setSuccess(tr("Ключ сохранён в OpenCode"));
      } else if (method.type === "oauth" && method.id) {
        const attempt = await api.oauthStart(
          selected.id,
          method.id,
          values,
          projectId,
        );
        setOauth(attempt);
        await api.openExternal(attempt.url);
      } else if (method.type === "external" && method.id) {
        await api.connectExternal(selected.id, method.id, values, projectId);
        setSelected(undefined);
        setSuccess(tr("Подключение сохранено"));
      }
      await reload();
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  }
  async function saveCustom() {
    if (!custom) return;
    setBusy(true);
    try {
      const {
        hint: _hint,
        preset,
        configured: _configured,
        ...provider
      } = custom;
      await api.customProvider({
        ...provider,
        baseUrl:
          preset === "omniroute"
            ? omniRouteBaseUrl(custom.baseUrl)
            : custom.baseUrl,
        model,
        key: secret || undefined,
        tools,
        images,
      });
      setSecret("");
      setCustom(undefined);
      setModel("");
      setSuccess(tr("Провайдер добавлен. Модель доступна в поле ввода."));
      await reload();
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  }
  function closeForm() {
    if (selected && oauth)
      void attempt(() =>
        api.oauthCancel(selected.id, oauth.attemptID, projectId),
      );
    setSelected(undefined);
    setCustom(undefined);
    setOauth(undefined);
    setSecret("");
    clearCatalog();
  }
  const alternateAuth =
    custom?.id &&
    integrations?.find(
      (integration) =>
        integration.id === custom.id &&
        integration.methods.some(
          (method) => method.type === "oauth" || method.type === "external",
        ),
    );

  return (
    <>
      <div
        className="connections-settings"
        id="setting-connections"
        tabIndex={-1}
      >
        <SettingsGroup title={tr("Подключения")}>
          {success && <SettingsMessage kind="success">{success}</SettingsMessage>}
          {selected ? (
            <form
              className="connection-form"
              onSubmit={(e) => {
                e.preventDefault();
                void connect();
              }}
            >
              <button
                type="button"
                className="back-link"
                disabled={busy}
                onClick={closeForm}
              >
                {tr("← Все подключения")}
              </button>
              <h4 ref={formHeading} tabIndex={-1}>
                {selected.name}
              </h4>
              {selected.methods.length > 1 && (
                <label className="field">
                  <span>{tr("Способ подключения")}</span>
                  <CustomSelect
                    aria-label={tr("Способ подключения")}
                    value={String(methodIndex)}
                    disabled={!!oauth}
                    onChange={(value) => {
                      const index = Number(value);
                      setMethodIndex(index);
                      setValues(defaults(selected.methods[index].form ?? []));
                    }}
                    options={selected.methods.map((m, i) => ({
                      value: String(i), label: m.label ?? m.type,
                    }))}
                  />
                </label>
              )}
              {oauth ? (
                <>
                  <p>{oauth.instructions}</p>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      void attempt(() => api.openExternal(oauth.url))
                    }
                  >
                    <ExternalLink size={14} />
                    {tr("Открыть авторизацию")}
                  </button>
                  {oauth.mode === "code" && (
                    <label className="field">
                      <span>{tr("Код авторизации")}</span>
                      <input
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        autoComplete="off"
                      />
                    </label>
                  )}
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      void attempt(() =>
                        api.oauthComplete(
                          selected.id,
                          oauth.attemptID,
                          code || undefined,
                          projectId,
                        ),
                      )
                    }
                  >
                    {tr("Проверить авторизацию")}
                  </button>
                </>
              ) : (
                <>
                  <Fields
                    fields={selected.methods[methodIndex]?.form ?? []}
                    values={values}
                    change={setValues}
                  />
                  {selected.methods[methodIndex]?.type === "key" && (
                    <label className="field">
                      <span>{tr("API ключ")}</span>
                      <input
                        type="password"
                        autoComplete="off"
                        value={secret}
                        onChange={(e) => setSecret(e.target.value)}
                        required
                        placeholder={tr("Ключ не будет показан повторно")}
                      />
                    </label>
                  )}
                  {["key", "oauth", "external"].includes(
                    selected.methods[methodIndex]?.type,
                  ) ? (
                    <button className="primary" disabled={busy}>
                      {busy && <LoaderCircle size={14} className="spin" />}
                      {tr("Подключить")}
                    </button>
                  ) : (
                    <p className="hint">
                      {tr(
                        "Этот способ подключается в OpenCode CLI. Для API ключа используйте другой способ или ручное подключение ниже.",
                      )}
                    </p>
                  )}
                </>
              )}
            </form>
          ) : custom ? (
            <form
              className="connection-form"
              onSubmit={(e) => {
                e.preventDefault();
                void saveCustom();
              }}
            >
              <button
                type="button"
                className="back-link"
                disabled={busy}
                onClick={closeForm}
              >
                {tr("← Все подключения")}
              </button>
              <h4 ref={formHeading} tabIndex={-1}>
                {custom.name || tr("Свой провайдер")}
              </h4>
              {alternateAuth && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => choose(alternateAuth)}
                >
                  {tr("Способы входа через OpenCode")}
                </button>
              )}
              <div className="field-row">
                <label className="field">
                  <span>{tr("Название")}</span>
                  <input
                    value={custom.name}
                    onChange={(e) =>
                      setCustom({ ...custom, name: e.target.value })
                    }
                    required
                  />
                </label>
                <label className="field">
                  <span>{tr("ID провайдера")}</span>
                  <input
                    value={custom.id}
                    pattern={String.raw`[a-z0-9][a-z0-9_\-]*`}
                    onChange={(e) =>
                      setCustom({ ...custom, id: e.target.value })
                    }
                    required
                  />
                </label>
              </div>
              {custom.preset === "omniroute" ? (
                <p className="hint">
                  API: OpenAI compatible · Chat Completions
                </p>
              ) : (
                <label className="field">
                  <span>API</span>
                  <CustomSelect
                    aria-label="API"
                    value={custom.runtime}
                    onChange={(value) =>
                      setCustom({
                        ...custom,
                        runtime: value as Custom["runtime"],
                      })
                    }
                    options={[
                      { value: "compatible", label: "OpenAI compatible" },
                      { value: "openai", label: "OpenAI" },
                      { value: "anthropic", label: "Anthropic" },
                      { value: "openrouter", label: "OpenRouter" },
                    ]}
                  />
                </label>
              )}
              <label className="field">
                <span>Base URL</span>
                <input
                  type="url"
                  required
                  value={custom.baseUrl}
                  onChange={(e) => {
                    clearCatalog();
                    setCustom({ ...custom, baseUrl: e.target.value });
                  }}
                />
              </label>
              {custom.preset === "omniroute" && (
                <p className="hint">
                  {tr(
                    "API URL из Endpoints OmniRoute: локальный адрес или ваш HTTPS-сервер с /v1. Используется Chat Completions с потоковыми ответами; ключ вводится отдельно ниже.",
                  )}
                </p>
              )}
              <label className="field">
                <span>{tr("Точный ID модели")}</span>
                <input
                  required
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={tr(custom.hint ?? "model-id")}
                />
                <small>
                  {tr(
                    "Отправляется провайдеру без замены. Можно добавить ещё одну модель с тем же ID провайдера.",
                  )}
                </small>
              </label>
              <label className="field">
                <span>
                  {tr("API ключ ")}
                  <small>{tr("(если требуется)")}</small>
                </span>
                <input
                  type="password"
                  value={secret}
                  placeholder={
                    custom.configured
                      ? tr(
                          "Оставьте пустым, чтобы сохранить текущую настройку ключа",
                        )
                      : undefined
                  }
                  onChange={(e) => {
                    clearCatalog();
                    setSecret(e.target.value);
                  }}
                  autoComplete="off"
                />
              </label>
              {custom.preset === "omniroute" && (
                <div className="provider-catalog">
                  <button
                    type="button"
                    className="secondary"
                    disabled={catalogBusy || busy}
                    onClick={() => void loadCatalog()}
                  >
                    {catalogBusy ? (
                      <LoaderCircle size={14} className="spin" />
                    ) : (
                      <RefreshCw size={14} />
                    )}
                    {tr("Загрузить модели OmniRoute")}
                  </button>
                  {catalog &&
                    (catalog.length ? (
                      <label className="field">
                        <span id="omniroute-catalog-label">
                          {tr("Каталог OmniRoute · ")}
                          {catalog.length}
                        </span>
                        <CustomSelect
                          aria-labelledby="omniroute-catalog-label"
                          value={
                            catalog.some((m) => m.id === model) ? model : ""
                          }
                          onChange={setModel}
                          options={[
                            { value: "", label: tr("Выберите точный ID модели или combo") },
                            ...catalog.map((m) => ({
                              value: m.id, label: m.name === m.id ? m.id : `${m.id} · ${m.name}`,
                            })),
                          ]}
                        />
                      </label>
                    ) : (
                      <p className="hint">
                        {tr(
                          "Сервер доступен, но каталог пуст. Добавьте модели в OmniRoute или введите известный ID вручную.",
                        )}
                      </p>
                    ))}
                  <p className="hint">
                    {tr(
                      "Выберите chat-модель с поддержкой инструментов. Медиа-модели из каталога для coding agent не подходят. Combo выбирает upstream средствами OmniRoute.",
                    )}
                  </p>
                </div>
              )}
              <div className="checkbox-row">
                <label>
                  <input
                    type="checkbox"
                    checked={tools}
                    onChange={(e) => setTools(e.target.checked)}
                  />
                  {tr("Инструменты")}
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={images}
                    onChange={(e) => setImages(e.target.checked)}
                  />
                  {tr("Изображения")}
                </label>
              </div>
              <p className="hint">
                {tr(
                  "Укажите возможности вашей модели. Подключение хранится в конфигурации OpenCode приложения, ключ — в его хранилище учётных данных.",
                )}
              </p>
              <button className="primary" disabled={busy}>
                {busy && <LoaderCircle className="spin" size={14} />}
                {tr("Сохранить подключение")}
              </button>
            </form>
          ) : null}
          <div hidden={formOpen}>
            <div className="connections-toolbar">
              <h4>{tr("Настроенные подключения")}</h4>
              <IconButton
                label={tr("Обновить подключения")}
                disabled={busy || engine.state !== "ready"}
                onClick={() => void attempt(reload)}
              >
                <RefreshCw size={14} />
              </IconButton>
            </div>
            {connected?.length ? (
              <div className="integration-list configured-providers">
                {connected.map((integration) => (
                  <ProviderRow
                    key={integration.id}
                    integration={integration}
                    choose={openProvider}
                    disabled={busy}
                  />
                ))}
              </div>
            ) : (
              <p className="hint">
                {tr(
                  connected
                    ? "Нет настроенных подключений."
                    : "Сведения о подключениях пока недоступны.",
                )}
              </p>
            )}
            <button
              ref={addButton}
              className="secondary add-connection"
              disabled={busy}
              popoverTarget="provider-picker"
              aria-haspopup="dialog"
              onKeyDown={(event) => {
                if (pickerOpen && event.key === "Escape") event.stopPropagation();
              }}
            >
              <Plus size={14} aria-hidden="true" />
              {tr("Добавить подключение")}
            </button>
            <div
              id="provider-picker"
              ref={picker}
              className="provider-picker"
              popover="auto"
              role="dialog"
              aria-label={tr("Добавить подключение")}
              onToggle={(event) => {
                const open = event.newState === "open";
                setPickerOpen(open);
                if (open) setCatalogOpen(false);
              }}
            >
              {pickerOpen && (
                <ProviderDirectory
                  integrations={integrations}
                  disabled={busy}
                  choose={(integration) =>
                    fromPicker((source) => openProvider(integration, source))
                  }
                  choosePreset={(preset) =>
                    fromPicker((source) => void choosePreset(preset, source))
                  }
                  chooseCustom={() =>
                    fromPicker((source) => {
                      returnFocus.current = source;
                      setCustom({
                        id: "",
                        name: "",
                        baseUrl: "",
                        runtime: "compatible",
                      });
                      setModel("");
                      setSecret("");
                      setSuccess("");
                    })
                  }
                />
              )}
            </div>
            <section className="provider-catalog-section">
              <h4>
                <button
                  className="provider-catalog-toggle"
                  aria-expanded={catalogOpen}
                  aria-controls="provider-directory-panel"
                  onClick={() => setCatalogOpen(!catalogOpen)}
                >
                  <ChevronRight size={14} aria-hidden="true" />
                  {tr("Каталог провайдеров")}
                  {integrations && (
                    <small className="catalog-total">
                      · {integrations.length}
                    </small>
                  )}
                </button>
              </h4>
              <div id="provider-directory-panel" hidden={!catalogOpen}>
                {catalogOpen && (
                  <ProviderDirectory
                    integrations={integrations}
                    disabled={busy}
                    choose={openProvider}
                  />
                )}
              </div>
            </section>
          </div>
        </SettingsGroup>
      </div>
    </>
  );
}

function ProviderDirectory({
  integrations,
  choose,
  disabled,
  choosePreset,
  chooseCustom,
}: {
  integrations?: Integration[];
  choose: (integration: Integration, source: HTMLElement) => void;
  disabled: boolean;
  choosePreset?: (preset: Custom) => void;
  chooseCustom?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [authFilter, setAuthFilter] = useState("all");
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const picker = !!choosePreset;
  const term = query.trim().toLocaleLowerCase();
  const matches = ({ name, id }: { name: string; id: string }) =>
    `${name} ${id}`.toLocaleLowerCase().includes(term);
  const entries = [
    ...(picker ? presets.filter(matches).map((preset) => ({ preset })) : []),
    ...(integrations ?? [])
      .filter(
        (integration) =>
          matches(integration) &&
          (!picker ||
            !presets.some((preset) => preset.id === integration.id)) &&
          (authFilter === "all" ||
            integration.methods.some((method) => method.type === authFilter)),
      )
      .map((integration) => ({ integration })),
  ];
  const pageCount = Math.max(1, Math.ceil(entries.length / pageSize));
  const visiblePage = Math.min(page, pageCount - 1);
  useEffect(() => {
    if (picker) search.current?.focus();
  }, [picker]);
  useEffect(() => {
    list.current?.scrollTo({ top: 0 });
  }, [term, authFilter, visiblePage]);

  function navigate(event: KeyboardEvent<HTMLElement>) {
    if (
      event.nativeEvent.isComposing ||
      !["ArrowDown", "ArrowUp", "Enter"].includes(event.key)
    )
      return;
    const buttons = [
      ...(list.current?.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)",
      ) ?? []),
    ];
    if (!buttons.length) return;
    if (event.target === search.current) {
      event.preventDefault();
      if (event.key === "Enter") buttons[0].click();
      else (event.key === "ArrowDown" ? buttons[0] : buttons.at(-1))?.focus();
    } else if (event.key !== "Enter") {
      event.preventDefault();
      const index = buttons.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      if (event.key === "ArrowUp" && index === 0) search.current?.focus();
      else buttons[index + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
    }
  }

  return (
    <div className="provider-directory">
      <div className="provider-directory-tools">
        <div className="search-input">
          <Search size={15} aria-hidden="true" />
          <input
            ref={search}
            aria-label={tr("Поиск провайдеров")}
            value={query}
            placeholder={tr("Найти провайдера…")}
            onKeyDown={navigate}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
          />
        </div>
        {!picker && (
          <CustomSelect
            aria-label={tr("Фильтр провайдеров")}
            value={authFilter}
            onChange={(value) => {
              setAuthFilter(value);
              setPage(0);
            }}
            options={[
              { value: "all", label: tr("Все способы входа") },
              { value: "oauth", label: "OAuth" },
              { value: "key", label: "API key" },
              { value: "external", label: "External" },
            ]}
          />
        )}
      </div>
      {entries.length ? (
        <div className="integration-list" ref={list} onKeyDown={navigate}>
          {entries
            .slice(visiblePage * pageSize, (visiblePage + 1) * pageSize)
            .map((entry) =>
              "preset" in entry ? (
                <button
                  key={entry.preset.id}
                  disabled={disabled}
                  onClick={() => choosePreset?.(entry.preset)}
                >
                  <span>{entry.preset.name}</span>
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              ) : (
                <ProviderRow
                  key={entry.integration.id}
                  integration={entry.integration}
                  choose={choose}
                  disabled={disabled}
                />
              ),
            )}
        </div>
      ) : (
        <p className="hint" role="status">
          {tr(
            integrations
              ? "Провайдеры не найдены."
              : "Каталог провайдеров пока недоступен.",
          )}
        </p>
      )}
      {pageCount > 1 && (
        <div className="provider-directory-pagination">
          <small aria-live="polite">
            {visiblePage + 1} / {pageCount}
          </small>
          <button
            className="secondary"
            disabled={visiblePage === 0}
            onClick={() => setPage(visiblePage - 1)}
          >
            {tr("Назад")}
          </button>
          <button
            className="secondary"
            disabled={visiblePage + 1 === pageCount}
            onClick={() => setPage(visiblePage + 1)}
          >
            {tr("Далее")}
          </button>
        </div>
      )}
      {chooseCustom && (
        <button
          className="secondary provider-custom-action"
          disabled={disabled}
          onClick={chooseCustom}
        >
          <Plus size={14} aria-hidden="true" />
          {tr("Другой провайдер / свой сервер")}
        </button>
      )}
    </div>
  );
}

function ProviderRow({
  integration,
  choose,
  disabled,
}: {
  integration: Integration;
  choose: (integration: Integration, source: HTMLElement) => void;
  disabled: boolean;
}) {
  const methods = [
    ...new Set(
      integration.methods.map((method) =>
        tr(authMethods[method.type] ?? method.type),
      ),
    ),
  ];
  return (
    <button
      disabled={disabled}
      onClick={(event) => choose(integration, event.currentTarget)}
    >
      <span>
        <strong>{integration.name}</strong>
        <small
          className={integration.needsAuth ? "needs-auth" : undefined}
          title={
            !integration.needsAuth &&
            (integration.connected || integration.custom)
              ? tr("Авторизация проверяется при обращении к провайдеру.")
              : undefined
          }
        >
          {integration.needsAuth
            ? tr("Требуется авторизация")
            : integration.connected || integration.custom
              ? tr("Настроен")
              : methods.join(" · ")}
        </small>
      </span>
      <ChevronRight size={14} aria-hidden="true" />
    </button>
  );
}
