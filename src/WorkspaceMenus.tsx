import { tr, useLanguage } from "./i18n";
import { useState } from "react";
import {
  Archive,
  BookOpen,
  Check,
  ChevronDown,
  Info,
  MessageCircle,
  Settings2,
  Wrench,
} from "lucide-react";
import { FloatingPanel } from "./components";
import { api, attempt, switchWorkspace, useApp } from "./store";
import { BrandIcon } from "./BrandIcon";

export function WorkspaceSwitcher() {
  useLanguage();

  const workspace = useApp((s) => s.preferences.workspace ?? "work");
  const [point, setPoint] = useState<{ x: number; y: number }>();
  return (
    <>
      <button
        className="sidebar-title faction-switcher"
        aria-label={tr("Переключить рабочее пространство")}
        aria-expanded={!!point}
        data-menu-trigger
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          setPoint(point ? undefined : { x: box.left, y: box.bottom + 6 });
        }}
      >
        <span>
          <strong>Rote Coding Fraktion</strong>
          <small>
            {workspace === "chat" ? "Chat Faction" : "Work Faction"}
          </small>
        </span>
        <ChevronDown size={12} />
      </button>
      {point && (
        <FloatingPanel
          label={tr("Рабочие пространства")}
          position={point}
          close={() => setPoint(undefined)}
          className="faction-menu"
        >
          {(
            [
              {
                id: "work",
                name: "Work Faction",
                description: tr("Агентская разработка"),
                icon: Wrench,
              },
              {
                id: "chat",
                name: "Chat Faction",
                description: tr("Общение и анализ вложений"),
                icon: MessageCircle,
              },
            ] as const
          ).map((item) => (
            <button
              role="menuitemradio"
              aria-checked={workspace === item.id}
              key={item.id}
              onClick={() => {
                setPoint(undefined);
                void attempt(() => switchWorkspace(item.id));
              }}
            >
              <item.icon size={17} />
              <span>
                <strong>{item.name}</strong>
                <small>{item.description}</small>
              </span>
              {workspace === item.id && <Check size={15} />}
            </button>
          ))}
        </FloatingPanel>
      )}
    </>
  );
}

export function ApplicationMenu({ onArchive }: { onArchive: () => void }) {
  useLanguage();

  const state = useApp();
  const [point, setPoint] = useState<{ x: number; y: number }>();
  const close = () => setPoint(undefined);
  return (
    <>
      <button
        className="local-avatar"
        aria-label={tr("Меню Rote Coding Fraktion")}
        aria-expanded={!!point}
        data-menu-trigger
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          setPoint(
            point ? undefined : { x: box.right + 8, y: box.bottom - 260 },
          );
        }}
      >
        <BrandIcon />
      </button>
      {point && (
        <FloatingPanel
          position={point}
          close={close}
          label={tr("Меню приложения")}
          className="application-menu"
        >
          <div className="menu-heading">Rote Coding Fraktion · 0.2.3</div>
          <button
            role="menuitem"
            onClick={() => {
              close();
              state.set({ settings: true });
            }}
          >
            <Settings2 size={15} />
            {tr("Настройки")}
            <kbd>Ctrl ,</kbd>
          </button>
          <button
            role="menuitem"
            onClick={() => {
              close();
              onArchive();
            }}
          >
            <Archive size={15} />
            {tr("Архив")}
          </button>
          <button
            role="menuitem"
            onClick={() => {
              close();
              void attempt(() => api.openExternal("https://opencode.ai/docs/"));
            }}
          >
            <BookOpen size={15} />
            {tr("Документация OpenCode")}
          </button>
          <button
            role="menuitem"
            onClick={() => {
              close();
              state.set({ settings: true, settingsSection: "about" });
            }}
          >
            <Info size={15} />
            {tr("О приложении")}
          </button>
          <div className="menu-divider" />
          <div className="app-engine-state">
            <span className={`status-dot ${state.engine.state}`} />
            <span>
              OpenCode {state.engine.version ?? ""} ·{" "}
              {state.engine.state === "ready"
                ? tr("подключён")
                : tr("нет связи")}
            </span>
          </div>
          <button
            role="menuitem"
            onClick={() => {
              close();
              void attempt(() => api.retryEngine());
            }}
          >
            {tr("Перезапустить движок…")}
          </button>
        </FloatingPanel>
      )}
    </>
  );
}
