# RCF 0.2.1 — выпадающие списки, редактор памяти и плотность

22 ноября 2026 года

## Изменения

- **CustomSelect.** Все системные `<select>` в интерфейсе RCF переведены на общий компонент. Он использует палитру приложения, бордовое состояние выбора и верхний слой Electron, поэтому меню доступно поверх прокручиваемых настроек и диалогов. Есть выбор мышью и с клавиатуры, поиск по началу названия и прокрутка длинных списков.
- **Память.** Создание и редактирование записей открываются в центральном диалоге шириной до 536 px. В нём находятся область использования, текст, счётчик и прежние действия сохранения и отмены. Для чтения длинной записи по-прежнему открывается боковая панель.
- **Плотность.** Значение уже сохранялось и доходило до CSS. Старые правила задавали меньшую минимальную высоту строк проектов и чатов, у которых уже была фиксированная высота. Настройки и память почти не использовали этот режим. Теперь общие токены задают фактические высоты и отступы. На 1440×960 высота строк навигации, проектов и чатов меняется с 34 до 28 px, высота селектора с 34 до 29 px, а размер шрифта селектора остаётся 12 px.

## Проверки

| Команда | Результат |
| --- | --- |
| `npm run build` | Production-сборка и TypeScript прошли. Vite предупредил о JS-чанке больше 500 КБ. |
| `npm test` | 47 из 47 модульных тестов прошли. |
| `node scripts/custom-controls-ui.mjs` | 12 комбинаций двух тем, двух плотностей и размеров 1440×960, 1080×720, 780×600. Проверены клавиши, поиск по префиксу, возврат фокуса, клик снаружи, длинные списки, горизонтальные границы меню, размеры редактора, отмена и лимит 2000 символов. Плотность, тема и проект сохранились после перезапуска. [Протокол](test-results/custom-controls/verification.json) |
| `node scripts/appearance-ui.mjs`, `npm run test:settings` | Настройки внешнего вида, сохранение параметров и геометрия вплоть до масштаба 200%. |
| `node scripts/memory-settings-ui.mjs` | Создание, поиск и фильтры, редактирование, отмена, удаление, очистка выбранной области, клавиатура и сохранность записей. |
| `node scripts/model-settings-ui.mjs`, `npm run test:omniroute` | Каталог и варианты моделей, фильтр провайдеров, форма OAuth, тип API, точные ID OmniRoute и локальный обмен через OpenCode. |
| `npm run test:rcf-ui`, `npm run test:composer-context` | Формы помощников, рабочие папки, локальный сценарий MCP и сохранность контекста. |
| `npm run test:recents-language` | Переключение языка в обе стороны, локализация и сохранение после перезапуска. |
| `node scripts/settings-redesign-ui.mjs`, `node scripts/ux-refinement-ui.mjs` | 48 снимков интерфейса настроек и 246 регрессионных проверок, в том числе 192 комбинации страниц, тем, размеров и масштаба. |
| `npm run test:desktop`, `node scripts/premium-ux-ui.mjs` | Запуск Electron 45.3.2 и локального OpenCode, разрешения, геометрия панели окна и цикл надписей. |

Проверки доступности охватывают ARIA-роли и управление через клавиатуру в Electron. Сценарии со скринридером и реальные внешние учётные записи в этот прогон не входили.

## Снимки Electron до и после

| Экран | До | После |
| --- | --- | --- |
| Редактор памяти, тёмная тема | [Боковая панель](test-results/custom-controls/before-editor-dark.png) | [Центральный диалог](test-results/custom-controls/after-editor-dark.png) |
| Редактор памяти, светлая тема | [Боковая панель](test-results/custom-controls/before-editor-light.png) | [Центральный диалог](test-results/custom-controls/after-editor-light.png) |
| Внешний вид, тёмная тема | [Исходные элементы](test-results/custom-controls/before-appearance-dark.png) | [Открытый CustomSelect](test-results/custom-controls/after-select-dark.png) |
| Внешний вид, светлая тема | [Исходные элементы](test-results/custom-controls/before-appearance-light.png) | [Открытый CustomSelect](test-results/custom-controls/after-select-light.png) |

Выбор области внутри редактора в [тёмной](test-results/custom-controls/after-editor-scope-dark.png) и [светлой теме](test-results/custom-controls/after-editor-scope-light.png).

## Изменённые файлы

- Общий компонент и стили: `src/CustomSelect.tsx`, `src/custom-select.css`.
- Подключение селекторов: `src/AppearanceSettings.tsx`, `src/Settings.tsx`, `src/ModelSettings.tsx`, `src/ConnectionsSettings.tsx`, `src/Fields.tsx`, `src/ComposerAddMenu.tsx`, `src/TaskControl.tsx`.
- Редактор и плотность: `src/MemorySettings.tsx`, `src/memory-settings.css`, `src/styles.css`, `src/settings.css`, `src/model-settings.css`, `src/task-control.css`, `src/composer-context.css`.
- Проверки Electron: `scripts/custom-controls-ui.mjs`, `scripts/select-ui.mjs`, `scripts/appearance-ui.mjs`, `scripts/settings-ui.mjs`, `scripts/settings-redesign-ui.mjs`, `scripts/memory-settings-ui.mjs`, `scripts/model-settings-ui.mjs`, `scripts/omniroute-ui.mjs`, `scripts/rcf-ui.mjs`, `scripts/composer-context-ui.mjs`, `scripts/recents-language-ui.mjs`, `scripts/premium-ux-ui.mjs`.
