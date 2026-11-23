import { tr, useLanguage } from "./i18n";
import type { Preferences } from "../shared/types";
import { savePreferences, useApp, report } from "./store";
import { SettingRow, Toggle, SettingsGroup } from "./SettingsControls";
import { CustomSelect } from "./CustomSelect";
export function AppearanceSettings() {
  useLanguage();

  const { preferences } = useApp();
  const numberSelect = (
    id: string,
    value: number,
    values: number[],
    change: (value: number) => void,
    suffix: string,
  ) => (
    <CustomSelect
      aria-labelledby={`label-${id}`}
      value={String(value)}
      onChange={(value) => change(Number(value))}
      options={values.map((size) => ({ value: String(size), label: size + suffix }))}
    />
  );

  async function update(value: Partial<Preferences>) {
    try {
      await savePreferences(value);
    } catch (error) {
      report(error);
    }
  }
  return (
    <div className="appearance-settings">
      <SettingsGroup title={tr("Интерфейс")}>
        <SettingRow
          id="theme"
          title={tr("Тема")}
          description={tr("Цветовая палитра приложения.")}
        >
          <CustomSelect
            aria-labelledby="label-theme"
            value={preferences.theme ?? "dark"}
            onChange={(value) =>
              void update({ theme: value as Preferences["theme"] })
            }
            options={[
              { value: "dark", label: tr("Тёмная") },
              { value: "light", label: tr("Светлая") },
            ]}
          />
        </SettingRow>
        <SettingRow
          id="scale"
          title={tr("Масштаб интерфейса")}
          description={tr("Размер всех элементов от 80 до 200%.")}
        >
          {numberSelect(
            "scale",
            preferences.uiScale ?? 100,
            [80, 90, 100, 110, 120, 125, 130, 140, 150, 200],
            (uiScale) => void update({ uiScale }),
            "%",
          )}
        </SettingRow>
        <SettingRow
          id="density"
          title={tr("Плотность элементов")}
          description={tr("Отступы в списках и строках.")}
        >
          <CustomSelect
            aria-labelledby="label-density"
            value={preferences.density ?? "comfortable"}
            onChange={(value) =>
              void update({
                density: value as Preferences["density"],
              })
            }
            options={[
              { value: "comfortable", label: tr("Комфортная") },
              { value: "compact", label: tr("Компактная") },
            ]}
          />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title={tr("Типографика")}>
        <SettingRow
          id="chat-font"
          title={tr("Размер шрифта чата")}
          description={tr("Основной текст сообщений и редактора.")}
        >
          {numberSelect(
            "chat-font",
            preferences.chatFontSize ?? 14,
            Array.from({ length: 9 }, (_, i) => i + 12),
            (chatFontSize) => void update({ chatFontSize }),
            " px",
          )}
        </SettingRow>
        <SettingRow
          id="code-font"
          title={tr("Размер шрифта кода")}
          description={tr("Текст в блоках кода и техническом выводе.")}
        >
          {numberSelect(
            "code-font",
            preferences.codeFontSize ?? 12,
            Array.from({ length: 8 }, (_, i) => i + 11),
            (codeFontSize) => void update({ codeFontSize }),
            " px",
          )}
        </SettingRow>
        <div className="settings-type-preview">
          <p style={{ fontSize: preferences.chatFontSize ?? 14 }}>
            {tr(
              "Rote Coding Fraktion помогает исследовать проект и воплощать идеи.",
            )}
          </p>
          <code style={{ fontSize: preferences.codeFontSize ?? 12 }}>
            const workspace = "Rote Coding Fraktion";
          </code>
        </div>
      </SettingsGroup>
      <SettingsGroup title={tr("Боковая панель")}>
        <SettingRow
          id="sidebar-width"
          title={tr("Ширина боковой панели")}
          description={tr("Ширина списка проектов и чатов.")}
        >
          {numberSelect(
            "sidebar-width",
            preferences.sidebarWidth ?? 260,
            [210, 230, 242, 260, 280, 320, 360, 400],
            (sidebarWidth) => void update({ sidebarWidth }),
            " px",
          )}
        </SettingRow>
        <SettingRow
          id="show-projects"
          title={tr("Показывать проекты")}
          description={tr("Группировать чаты по открытым папкам.")}
        >
          <Toggle
            id="show-projects"
            value={preferences.showProjects !== false}
            change={(showProjects) => void update({ showProjects })}
          />
        </SettingRow>
        <SettingRow
          id="sort"
          title={tr("Сортировка чатов")}
          description={tr("Порядок в списке чатов.")}
        >
          <CustomSelect
            aria-labelledby="label-sort"
            value={preferences.chatSort ?? "updated"}
            onChange={(value) =>
              void update({
                chatSort: value as Preferences["chatSort"],
              })
            }
            options={[
              { value: "updated", label: tr("По последнему обновлению") },
              { value: "created", label: tr("По дате создания") },
              { value: "title", label: tr("По названию") },
            ]}
          />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title={tr("Движение")}>
        <SettingRow
          id="animations"
          title={tr("Анимации")}
          description={tr(
            "Мягкие переходы. Системное уменьшение движения также учитывается.",
          )}
        >
          <Toggle
            id="animations"
            value={preferences.animations !== false}
            change={(animations) => void update({ animations })}
          />
        </SettingRow>
      </SettingsGroup>
    </div>
  );
}
