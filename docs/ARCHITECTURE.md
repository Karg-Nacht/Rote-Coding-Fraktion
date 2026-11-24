# Архитектура RCF и проверенный API

В RCF 0.3.0 базовый движок и TypeScript-клиент закреплены на OpenCode 2.3.0. Менеджер движка также поддерживает OpenCode 2.3.2 с проверкой совместимости при запуске. [Текущая матрица совместимости](../README.md#opencode-compatibility).

Обновление 0.2.0: `WorktreeService` использует API OpenCode и ограниченные Git-примитивы; `AgentControlService` управляет реальными сессиями, Reviewer и точками истории. Привязки дополнительных директорий сохраняются в `task_directories`. История и исполнение остаются в OpenCode. [Полный отчёт RCF](../RCF-0.2.0-REPORT.md).

Дополнение 16 ноября: [рабочие пространства, память, PDF, поиск и актуальные ограничения](UPGRADE-2026-11-16.md). Движок/клиент остаются на 2.3.0; история остаётся в OpenCode, память — в SQLite RCF, копии вложений — в профиле `attachments/`.

15 ноября 2026. Начальная папка проекта была пуста. Приложение создано отдельно от существующих проектов пользователя.

## Технические решения

Предварительный план из ТЗ адаптирован после проверки установленного OpenCode: фактически установлен `@opencode/cli` **2.3.0**. `@opencode-ai/sdk` принадлежит V1; для текущей версии используется официальный **`@opencode/client` 2.3.0**.

Порядок реализации: сверка API → запуск защищённого сервиса → сессии/хранилище → UI → лента/streaming → провайдеры/разрешения → Git → real-engine/Electron проверки → Windows упаковка.

## Слои

| Слой | Ответственность |
|---|---|
| `electron/main.ts` | Жизненный цикл, окно, диалоги, whitelist IPC, Zod validation, подтверждения публикации/Full Access |
| `electron/preload.ts` | Единственный типизированный bridge; Node API не экспортируются |
| `OpenCodeSupervisor` | Bundled CLI, `Service.ensure/discover/stop`, отдельный state file, auth headers, readiness, точная версия |
| `SessionCoordinator` | Разрешённые проекты, сессии, очередь, модели, API snapshots, пагинация, ресинхронизация и ограниченный reconnect backoff |
| `LiveProjection` | Только полученные SSE-дельты, порядок text/tool, очистка после reconnect и замена канонической историей |
| `TimelineNormalizer` | История → компактные DTO; группировка смежных действий; reasoning исключён |
| `LocalStorage` | SQLite WAL: проекты, pins, предпочтения, drafts, scroll position. История сообщений не дублируется |
| `MediaService` | Chooser capabilities, URI/hash результатов, безопасный media protocol и размерные ограничения |
| `ProjectContextService` | Проверенное чтение проекта в Electron Main, ограниченный поиск, ранжирование и предпросмотр фрагментов в памяти |
| `WorkspaceGitService` | Фиксированные Git/gh операции, literal pathspecs, без shell-команд из Renderer |
| React + Zustand | Навигация, проекты, Markdown, настройки, разрешения, Git panel |
| TanStack Virtual | Переменная высота строк ленты; отдельная виртуализация длинного вывода |

## Project Intelligence

Composer отправляет через Zod-валидируемый IPC идентификатор добавленного проекта и вопрос. `ProjectContextService` получает путь из `LocalStorage`, проверяет канонический корень и права сессии, а затем выбирает фрагменты с относительными путями и номерами строк. Пределы включают 256 КиБ на файл, 2 000 проверяемых файлов, 16 МиБ чтения и до 35 файлов в контексте примерно на 32 000 символов. Предпросмотр и подготовленные фрагменты ограничены по времени жизни и хранятся в памяти.

Штатный хук запроса OpenCode добавляет фрагменты только к последнему сообщению с короткоживущим идентификатором активного запроса. Хук получает готовые фрагменты по каналу loopback с проверкой идентификатора сессии и случайного токена. Поиск по проекту выполняет Electron Main. OpenCode сохраняет обычный текст сообщения и ссылку на временный контекст. Сами фрагменты не записываются в историю OpenCode, SQLite RCF или журналы RCF. Ответы модели сохраняются как обычная переписка и могут содержать цитаты. Для Chat хук удаляет из запроса автоматически обнаруженные инструкции проекта и применяет текущие правила и память RCF из `instructions.entry`. Отключение контекста не добавляет ссылку в следующий запрос. Разрешения Chat Faction продолжают запрещать все инструменты.

## Подтверждённые методы V2

Используются `OpenCode.make`, `server.info`, `session.create/list/get/prompt/interrupt/active/update/switchModel/diff`, `session.inbox.*`, `session.form.*`, `message.list`, `model.list`, `integration.list/connect.key/connect.external/oauth.*`, `credential.create/list`, `location.reload`, `event.subscribe`.

Важные отличия от V1:

- `SessionMessageInfo` — tagged union с `type`; assistant имеет `content` с text/reasoning/tool.
- Инструменты имеют `state.status`, `input`, `content`, `metadata`, а также фактические времена.
- SSE события используют `data`, `id`, `created`, `sessionID`, `assistantMessageID`. Нет выдуманных V1 `message.part.updated`.
- `session.prompt` возвращает элемент inbox, а не финальный ответ модели.
- Разрешения — `permissions: [{action, resource, effect}]`, действия `shell` и `subagent`.
- Курсор содержит порядок; его нельзя отправлять вместе с `order`. Даже короткая страница может содержать `cursor.next`, поэтому конец определяем также по размеру страницы.
- SSE подписки live-only, без автоматического replay/reconnect. После reconnect выполняется API hydration.
- Промежуточный текст собирается по настоящим delta events. История заменяет transient projection после завершения.
- `location.reload` пересобирает все загруженные locations, после чего перечитываются модели.

## Проверенные первичные источники

- [JavaScript client и service lifecycle](https://opencode.ai/docs/build/client/)
- [V2 API reference](https://opencode.ai/docs/api)
- [V2 permissions](https://opencode.ai/docs/permissions/)
- [V2 provider configuration](https://opencode.ai/docs/providers/)
- [OpenCode 2.3.0 source and license](https://github.com/anomalyco/opencode/tree/v2.3.0)
- Сгенерированные типы и реализации из установленных `@opencode/client`, `@opencode/protocol`, `@opencode/schema` 2.3.0.

## Достоверность UI

Нет demo mode или встроенного фиктивного агента. Карточка изменений явно относится ко всей задаче, а не к одному tool call. Статистика приходит из `session.diff`/Git. Изображения обозначаются просмотренными только при успешном `read` с доступным image result. Универсальные инструменты остаются раскрываемыми. Undo не показывается без достоверного индивидуального отката.

Следующее развитие: аккаунты провайдеров в UI, более экономное обновление session summaries для большого количества проектов, управляемый импорт существующего OpenCode профиля, изоляция задач через worktree/VM, подписанные обновления и Linux package validation.
