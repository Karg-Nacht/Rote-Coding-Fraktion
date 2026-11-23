import { useEffect, useState } from "react";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import type { EngineUpdateInfo } from "../shared/engine-manager";
import { tr } from "./i18n";
import { api, attempt, savePreferences, useApp } from "./store";
import { SettingRow, SettingsDisclosure, SettingsMessage, Toggle } from "./SettingsControls";

export function EngineSettings({ connection, restart }: { connection: string; restart: () => void }) {
  const engine = useApp((s) => s.engine);
  const update = useApp((s) => s.engineUpdate);
  const preferences = useApp((s) => s.preferences);
  const running = useApp((s) => s.sessions.some((session) => session.running) || !!s.snapshot?.session.running);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let live = true;
    void attempt(async () => {
      const info = await api.engineUpdateInfo();
      if (live) useApp.getState().set({ engineUpdate: info });
    });
    return () => { live = false; };
  }, []);
  async function run(action: () => Promise<EngineUpdateInfo>) {
    setPending(true);
    try {
      const engineUpdate = await attempt(action);
      if (engineUpdate) useApp.getState().set({ engineUpdate });
    } finally {
      setPending(false);
    }
  }
  const busy = pending || !!(update?.phase && update.phase !== "idle");
  const phase = {
    idle: "",
    checking: tr("Проверяем обновления OpenCode…"),
    downloading: tr("Скачиваем и проверяем пакет OpenCode…"),
    testing: tr("Проверяем OpenCode на тестовом профиле…"),
    switching: tr("Копируем профиль и переключаем версию…"),
    rollback: tr("Восстанавливаем предыдущий профиль…"),
  }[update?.phase ?? "idle"];
  const source = {
    bundled: tr("В комплекте с RCF"),
    managed: tr("Установлен через RCF"),
    external: tr("Внешняя установка"),
  }[update?.source ?? "bundled"];
  const states = {
    compatible: tr("Совместим"),
    partial: tr("Частично совместим"),
    incompatible: tr("Несовместим"),
    unchecked: tr("Не проверен"),
  };
  const features = {
    connection: tr("Соединение"),
    history: tr("Сессии и история"),
    messages: tr("Отправка сообщений"),
    stream: tr("Поток событий"),
    tools: tr("Вызовы инструментов"),
    permissions: tr("Разрешения OpenCode"),
    models: tr("Модели и провайдеры"),
    diff: tr("Git и изменения файлов"),
    agents: tr("Субагенты"),
  };
  const checkState = { verified: tr("Проверено"), unavailable: tr("Недоступно"), unchecked: tr("Не проверен") };
  const errors: Record<string, string> = {
    registry: tr("Не удалось проверить обновления. Проверьте подключение к реестру npm."),
    download: tr("Не удалось скачать пакет OpenCode. Текущая версия сохранена."),
    signature: tr("Подлинность пакета OpenCode не подтверждена подписью npm."),
    integrity: tr("Контрольная сумма пакета OpenCode не совпала."),
    candidate: tr("Новая версия OpenCode не запустилась на тестовом профиле. Текущая версия сохранена."),
    api: tr("API новой версии несовместим с текущим RCF. Требуется обновление приложения или проверенная версия OpenCode."),
    stop: tr("Не удалось остановить OpenCode для обслуживания."),
    backup: tr("Не удалось скопировать профиль OpenCode. Исходный профиль сохранён."),
    activation: tr("Версия не запустилась с этим профилем. RCF вернул исходную версию."),
    recovery: tr("Не удалось повторно запустить исходную версию. Откройте диагностику и повторите запуск."),
    journal: tr("Не удалось записать данные менеджера OpenCode."),
    manifest: tr("Сохранённые данные менеджера OpenCode повреждены. Для восстановления требуется проверка файла manager.json."),
  };
  const journal: Record<string, string> = {
    check: tr("Проверка обновлений"),
    install: tr("Подготовка версии"),
    switch: tr("Переключение версии"),
    rollback: tr("Возврат к версии"),
    checked: tr("Проверка завершена"),
    ready: tr("Подключён"),
    preparing: tr("Подготовка профиля"),
    available: tr("Доступно обновление"),
    compatible: states.compatible,
    partial: states.partial,
    ...errors,
  };
  const checkNotes: Record<string, string> = {
    "probe-passed": tr("Ответ локального сервера проверен."),
    "probe-failed": tr("Проверка ответа локального сервера не прошла."),
    "rcf-reference": tr("Проверено для этой версии в регрессиях RCF."),
    "schema-only": tr("Маршруты объявлены. Поведение не подтверждено."),
    "server.info": tr("Подтверждены версия и авторизация сервера."),
  };
  const installAllowed = !busy && !running && engine.state !== "starting" && engine.state !== "reconnecting";
  const diagnostic = update?.rejected ?? update?.staged;
  return (
    <section className="engine-settings">
      <SettingRow id="engine" title={tr("Локальный движок OpenCode")}
        description={`${tr("Установленная версия")} ${update?.installed ?? engine.version ?? "—"} · ${source}`}>
        <span className="setting-value"><span className={`status-dot ${engine.state}`} />{connection}</span>
      </SettingRow>
      <dl className="engine-facts">
        <div><dt>{tr("Стабильная версия")}</dt><dd>{update?.latest ?? "—"}</dd></div>
        <div><dt>{tr("Совместимость")}</dt><dd>{states[engine.compatibility?.state ?? "unchecked"]}</dd></div>
      </dl>
      <div className="settings-group engine-controls">
        <div className="engine-actions">
          <button className="secondary" disabled={busy} onClick={() => void run(() => api.checkEngineUpdate())}>
            {tr("Проверить обновления")}
          </button>
          {update?.available && update.canInstall && update.staged?.version !== update.latest && (
            <button className="secondary" disabled={!installAllowed} onClick={() => void run(() => api.installEngineUpdate())}>
              {tr("Скачать и проверить")}
            </button>
          )}
          {update?.staged && (
            <button className="secondary" disabled={!installAllowed} onClick={() => void run(() => api.switchEngineVersion())}>
              {tr("Переключить")} · {update.staged.version}
            </button>
          )}
          <button className="secondary" disabled={busy || engine.state === "starting" || engine.state === "reconnecting"} onClick={restart}>
            <RefreshCw size={14} />{tr("Перезапустить движок")}
          </button>
          {update?.previous && (
            <button className="secondary" disabled={!installAllowed} onClick={() => void run(() => api.rollbackEngineVersion())}>
              {tr("Вернуться")} · {update.previous}
            </button>
          )}
        </div>
        {phase && <p role="status">{phase}</p>}
        {!phase && running && <p>{tr("Переключение и установка доступны после завершения активных задач.")}</p>}
        {!phase && !running && update?.available && preferences.engineNotify !== false && (
          <p role="status">{tr("Доступно обновление")} · {update.latest}</p>
        )}
        {!phase && update?.checkedAt && !update.available && !update.error && (
          <p role="status">{tr("Обновлений нет.")}</p>
        )}
        {update?.staged && <p>{tr("Подготовлена версия")} {update.staged.version} · {states[update.staged.compatibility.state]}</p>}
        {update?.source === "external" && (
          <button className="text-button" onClick={() => void attempt(() => api.openExternal("https://opencode.ai/docs/"))}>
            {tr("Инструкции OpenCode для внешней установки")} <ArrowUpRight size={13} />
          </button>
        )}
        {update?.error && <SettingsMessage kind="error">{errors[update.error]}</SettingsMessage>}
        {engine.error && <SettingsMessage kind="error">{engine.error}</SettingsMessage>}
      </div>
      <SettingsDisclosure id="engine-diagnostics" title={tr("Диагностика OpenCode")}>
        <p>{tr("Для новых версий операции записи включаются после проверки RCF. Доступность чтения проверяется на локальном сервере.")}</p>
        {update?.checkedAt && <p>{tr("Последняя проверка обновлений")} · {new Date(update.checkedAt).toLocaleString(preferences.language ?? "ru")}</p>}
        {diagnostic && <p>{tr("Тестовая проверка")} · {diagnostic.version} · {states[diagnostic.compatibility.state]}</p>}
        {(diagnostic?.compatibility ?? engine.compatibility)?.checks.map((check) => (
          <div className="engine-check" key={check.feature}>
            <span>{features[check.feature]}</span>
            <span>{checkState[check.state]}<small>{checkNotes[check.detail] ?? check.detail}</small></span>
          </div>
        ))}
        {update?.journal.slice().reverse().map((entry, index) => (
          <div className="engine-check" key={index}>
            <time dateTime={new Date(entry.at).toISOString()}>{new Date(entry.at).toLocaleString(preferences.language ?? "ru")}</time>
            <span>{journal[entry.action]}<small>{journal[entry.result]}</small></span>
          </div>
        ))}
      </SettingsDisclosure>
      <SettingRow id="engine-auto-check" title={tr("Проверять обновления автоматически")}
        description={tr("Проверяет последнюю стабильную версию. Загрузка требует подтверждения.")}>
        <Toggle id="engine-auto-check" value={preferences.engineAutoCheck !== false}
          change={(engineAutoCheck) => void attempt(() => savePreferences({ engineAutoCheck }))} />
      </SettingRow>
      <SettingRow id="engine-notify" title={tr("Сообщать о новых стабильных версиях")}
        description={tr("Показывает сообщение в настройках после завершения задач.")}>
        <Toggle id="engine-notify" value={preferences.engineNotify !== false}
          change={(engineNotify) => void attempt(() => savePreferences({ engineNotify }))} />
      </SettingRow>
    </section>
  );
}
