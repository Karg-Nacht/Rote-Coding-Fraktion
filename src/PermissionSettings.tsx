import { ShieldCheck, TriangleAlert } from "lucide-react";
import type { Mode } from "../shared/types";
import { tr } from "./i18n";
import { SettingsDisclosure, SettingsGroup } from "./SettingsControls";

const modes = [
  {
    id: "cautious",
    name: "С подтверждением",
    description: "Изменения файлов и запуск команд требуют подтверждения.",
  },
  {
    id: "autonomous",
    name: "Автономно",
    description:
      "Самостоятельная работа в проекте с действующими ограничениями.",
  },
  {
    id: "full",
    name: "Полный доступ",
    description:
      "Команды, изменения файлов и внешний доступ без отдельных подтверждений.",
  },
] as const;

export function PermissionSettings({
  mode,
  onChange,
}: {
  mode: Mode;
  onChange: (mode: Mode) => void;
}) {
  return (
    <div className="permission-settings">
      <SettingsGroup title="Work Faction">
        <div
          className="permission-mode-list"
          id="setting-mode"
          role="radiogroup"
          aria-label={tr("Режим разрешений Work Faction")}
          tabIndex={-1}
        >
          {modes.map((item) => (
            <label
              key={item.id}
              className="permission-mode"
              data-mode={item.id}
            >
              <input
                type="radio"
                name="work-permission-mode"
                value={item.id}
                checked={mode === item.id}
                aria-labelledby={`permission-mode-name-${item.id}`}
                aria-describedby={`permission-mode-description-${item.id}`}
                onChange={() => onChange(item.id)}
              />
              <span className="permission-mode-copy">
                <span
                  className="permission-mode-name"
                  id={`permission-mode-name-${item.id}`}
                >
                  {tr(item.name)}
                  {item.id === "full" && (
                    <TriangleAlert size={14} aria-hidden="true" />
                  )}
                </span>
                <span id={`permission-mode-description-${item.id}`}>
                  {tr(item.description)}
                </span>
              </span>
            </label>
          ))}
        </div>
        <SettingsDisclosure
          id="work-permissions"
          title={tr("Подробнее о разрешениях")}
          focusableContainer={false}
        >
          <p>
            {tr(
              "Режим действует со следующего запроса. Без полного доступа OpenCode запрашивает подтверждение для доступа за пределами проекта и чтения файлов с чувствительными именами. В автономном режиме отдельные команды Git и GitHub также требуют подтверждения.",
            )}
          </p>
          <p>
            {tr(
              "Во всех режимах из субагентов OpenCode доступен только rcf-reader. Эти правила действуют на уровне инструментов OpenCode и не изолируют процесс на уровне операционной системы.",
            )}
          </p>
        </SettingsDisclosure>
      </SettingsGroup>
      <SettingsGroup title="Chat Faction">
        <div className="permission-chat-status">
          <ShieldCheck size={14} aria-hidden="true" />
          {tr("Инструменты отключены")}
        </div>
        <p className="permission-chat-description">
          {tr("Chat Faction не выполняет команды и не изменяет файлы.")}
        </p>
        <SettingsDisclosure
          id="chat-permissions"
          title={tr("Правила OpenCode")}
          focusableContainer={false}
        >
          <p>
            {tr(
              "OpenCode запрещает все инструменты, включая чтение файлов, внешние инструменты и субагентов. Chat Faction может анализировать переписку и прикреплённые вами файлы. Эти правила действуют при любом режиме Work Faction.",
            )}
          </p>
        </SettingsDisclosure>
      </SettingsGroup>
    </div>
  );
}
