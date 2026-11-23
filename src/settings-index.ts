import {
  Archive,
  Brain,
  Cpu,
  Info,
  Keyboard,
  Palette,
  Settings2,
  ShieldCheck,
} from "lucide-react";
export const categories = [
  {
    id: "general",
    title: "Основные",
    description: "Проекты и поведение приложения.",
    icon: Settings2,
  },
  {
    id: "appearance",
    title: "Внешний вид",
    description: "Настройте рабочее пространство под себя.",
    icon: Palette,
  },
  {
    id: "connections",
    title: "Модели и подключения",
    description: "Модели, провайдеры и способы авторизации.",
    icon: Cpu,
  },
  {
    id: "permissions",
    title: "Агенты и разрешения",
    description: "Управляйте доступом агента к вашему проекту.",
    icon: ShieldCheck,
  },
  {
    id: "memory",
    title: "Память и персонализация",
    description: "Сохранённый вами контекст для следующих разговоров.",
    icon: Brain,
  },
  {
    id: "history",
    title: "История и хранение",
    description: "Архив, переписка и сохранность данных.",
    icon: Archive,
  },
  {
    id: "shortcuts",
    title: "Горячие клавиши",
    description: "Быстрые действия с клавиатуры.",
    icon: Keyboard,
  },
  {
    id: "about",
    title: "О приложении",
    description: "Rote Coding Fraktion и локальный движок OpenCode.",
    icon: Info,
  },
] as const;
export type Category = (typeof categories)[number]["id"];
export const navigationGroups = [
  { title: "Приложение", sections: ["general", "appearance", "shortcuts"] },
  { title: "ИИ и агенты", sections: ["connections", "permissions", "memory"] },
  { title: "Данные и хранение", sections: ["history"] },
  { title: "Система", sections: ["about"] },
] as const satisfies readonly {
  title: string;
  sections: readonly Category[];
}[];
export type Parameter = {
  id: string;
  category: Category;
  title: string;
  description: string;
  keywords?: string;
};
// Search indexes real parameter labels, descriptions and common aliases.
export const parameters: Parameter[] = [
  {
    id: "project",
    category: "general",
    title: "Текущий проект",
    description: "Выбрать рабочую папку из открытых проектов.",
    keywords: "папка директория directory",
  },
  {
    id: "projects",
    category: "general",
    title: "Управление проектами",
    description: "Открыть папку или убрать проект из списка.",
  },
  {
    id: "language",
    category: "general",
    title: "Язык приложения",
    description: "Русский и английский язык интерфейса.",
    keywords: "language English русский английский",
  },
  {
    id: "lifecycle",
    category: "general",
    title: "Завершение и восстановление",
    description: "Поведение при закрытии и следующем запуске.",
    keywords: "сессия запуск закрытие",
  },
  {
    id: "theme",
    category: "appearance",
    title: "Тема",
    description:
      "Графитовая или светлая палитра с мягким красным оттенком боковой панели.",
  },
  {
    id: "scale",
    category: "appearance",
    title: "Масштаб интерфейса",
    description: "Размер всех элементов от 80 до 200%.",
    keywords: "zoom dpi scaling",
  },
  {
    id: "density",
    category: "appearance",
    title: "Плотность элементов",
    description: "Комфортные или компактные строки и отступы.",
  },
  {
    id: "chat-font",
    category: "appearance",
    title: "Размер шрифта чата",
    description: "Текст сообщений от 12 до 20 px.",
    keywords: "текст font",
  },
  {
    id: "code-font",
    category: "appearance",
    title: "Размер шрифта кода",
    description: "Текст в блоках кода от 11 до 18 px.",
    keywords: "font",
  },
  {
    id: "animations",
    category: "appearance",
    title: "Анимации",
    description: "Плавные переходы с учётом уменьшения движения.",
  },
  {
    id: "sidebar-width",
    category: "appearance",
    title: "Ширина боковой панели",
    description: "Ширина списка проектов и чатов.",
  },
  {
    id: "show-projects",
    category: "appearance",
    title: "Показывать проекты",
    description: "Группировка чатов по проектам.",
  },
  {
    id: "sort",
    category: "appearance",
    title: "Сортировка чатов",
    description: "По обновлению, созданию или названию.",
  },
  {
    id: "default-model",
    category: "connections",
    title: "Выбранная модель",
    description: "Модель и вариант размышления для следующих запросов.",
    keywords: "reasoning вариант",
  },
  {
    id: "favorites",
    category: "connections",
    title: "Закреплённые модели",
    description: "Избранные модели в меню редактора сообщений.",
  },
  {
    id: "connections",
    category: "connections",
    title: "Провайдеры и API-ключи",
    description: "Подключение, OAuth, свой сервер или локальная модель.",
    keywords:
      "omniroute openrouter openai anthropic ollama lm studio base url credentials каталог ключ авторизация",
  },
  {
    id: "mode",
    category: "permissions",
    title: "Режим разрешений Work Faction",
    description: "Подтверждения изменений, команд и внешнего доступа.",
    keywords:
      "с подтверждением автономно полный доступ cautious autonomous full access",
  },
  {
    id: "chat-permissions",
    category: "permissions",
    title: "Разрешения Chat Faction",
    description: "Общение и анализ с отключёнными инструментами OpenCode.",
    keywords: "чтение запись bash shell субагенты",
  },
  {
    id: "memory-enabled",
    category: "memory",
    title: "Использовать долговременную память",
    description: "Сохранённый контекст в следующих запросах.",
  },
  {
    id: "memory-records",
    category: "memory",
    title: "Записи памяти",
    description:
      "Добавление, редактирование и удаление общей памяти и памяти проекта.",
    keywords: "очистить запоминание исключения",
  },
  {
    id: "archive",
    category: "history",
    title: "Архив чатов",
    description: "Открыть архив и восстановить переписку.",
  },
  {
    id: "export",
    category: "history",
    title: "Копировать переписку",
    description: "Текст открытого чата в буфере обмена.",
    keywords: "экспорт export",
  },
  {
    id: "storage",
    category: "history",
    title: "Хранение данных",
    description: "История OpenCode, настройки и учётные данные.",
  },
  {
    id: "shortcuts",
    category: "shortcuts",
    title: "Команды и сочетания клавиш",
    description: "Поиск, новый чат, настройки, панель и редактор.",
    keywords: "ctrl enter shift esc клавиатура",
  },
  {
    id: "engine",
    category: "about",
    title: "Статус и версия OpenCode",
    description: "Совместимость, обновления, перезапуск и возврат к версии.",
    keywords: "restart update rollback диагностика ошибка",
  },
  {
    id: "version",
    category: "about",
    title: "Версия Rote Coding Fraktion",
    description: "Версия приложения 0.2.3.",
  },
  {
    id: "licenses",
    category: "about",
    title: "Лицензии и документация",
    description: "Используемые компоненты и справка OpenCode.",
  },
];
