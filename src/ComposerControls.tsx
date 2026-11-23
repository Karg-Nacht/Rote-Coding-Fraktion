import { tr, useLanguage } from "./i18n";
import {
  useEffect,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ArrowLeft,
  RotateCcw,
  Search,
  Shield,
  ShieldAlert,
  Zap,
} from "lucide-react";
import type { Mode } from "../shared/types";
import { attempt, savePreferences, useApp } from "./store";
import { IconButton } from "./components";
import "./model-controls.css";
import { EffortSlider } from "./EffortSlider";

// Position against the trigger, then clamp to the window (including resized sidebars).
function ComposerPopover({
  anchor,
  close,
  children,
  label,
  className,
  align = "end",
  role = "menu",
}: {
  anchor: RefObject<HTMLDivElement | null>;
  close: () => void;
  children: ReactNode;
  label: string;
  className: string;
  align?: "start" | "end";
  role?: "menu" | "dialog";
}) {
  useLanguage();

  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  const [point, setPoint] = useState({ left: 0, top: 0 });
  const updatePosition = useCallback(() => {
    const trigger = anchor.current?.getBoundingClientRect();
    const box = panel.current?.getBoundingClientRect();
    if (trigger && box) {
      const left = Math.max(
        8,
        Math.min(
          align === "start" ? trigger.left : trigger.right - box.width,
          innerWidth - box.width - 8,
        ),
      );
      const top = Math.max(40, trigger.top - box.height - 10);
      setPoint((previous) =>
        previous.left === left && previous.top === top
          ? previous
          : { left, top },
      );
    }
  }, [anchor, align]);
  useLayoutEffect(() => {
    updatePosition();
  });
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    let restore = true;
    const element = panel.current;
    (
      element?.querySelector<HTMLElement>("[data-autofocus]") ??
      element?.querySelector<HTMLElement>("input, button:not(:disabled)")
    )?.focus();
    const outside = (event: PointerEvent) => {
      if (
        !element?.contains(event.target as Node) &&
        !anchor.current?.contains(event.target as Node)
      ) {
        restore = false;
        closeRef.current();
      }
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      } else if (event.key === "Tab") {
        // Dialog controls (including the range) retain their normal tab order.
        if (role === "menu") {
          restore = false;
          closeRef.current();
        }
      } else if (
        role === "menu" &&
        ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
      ) {
        event.preventDefault();
        const items = [
          ...(element?.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ) ?? []),
        ];
        const current = items.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : (current +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  items.length) %
                items.length;
        items[next]?.focus();
      }
    };
    const focusOutside = (event: FocusEvent) => {
      if (
        !element?.contains(event.target as Node) &&
        !anchor.current?.contains(event.target as Node)
      ) {
        restore = false;
        closeRef.current();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", focusOutside);
    element?.addEventListener("keydown", keyboard);
    window.addEventListener("resize", updatePosition);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", focusOutside);
      element?.removeEventListener("keydown", keyboard);
      window.removeEventListener("resize", updatePosition);
      if (restore && previous?.isConnected) previous.focus();
    };
  }, [anchor, role, updatePosition]);
  return createPortal(
    <div
      ref={panel}
      style={point}
      className={`composer-popover ${className}`}
      role={role}
      aria-label={label}
    >
      {children}
    </div>,
    document.body,
  );
}

const modes = [
  {
    id: "cautious",
    name: "С подтверждением",
    short: "Подтверждать",
    description: "Изменения и команды — с подтверждением.",
    icon: Shield,
  },
  {
    id: "autonomous",
    name: "Автономно",
    short: "Автономно",
    description: "Работа в проекте. Внешний доступ — с подтверждением.",
    icon: Shield,
  },
  {
    id: "full",
    name: "Полный доступ",
    short: "Полный доступ",
    description: "Команды и файлы без отдельных подтверждений.",
    icon: ShieldAlert,
  },
] as const;

export function ComposerModeControl({
  disabled,
  changeMode,
}: {
  disabled: boolean;
  changeMode: (mode: Mode) => Promise<void>;
}) {
  useLanguage();

  const mode = useApp((s) => s.preferences.mode);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const active = modes.find((m) => m.id === mode)!;
  const ModeIcon = active.icon;
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  return (
    <div className="mode-menu-anchor" ref={anchor}>
      <button
        className={`mode-trigger ${mode === "full" ? "full-access" : ""}`}
        aria-label={tr("Режим разрешений")}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled || pending}
        title={tr(active.description)}
        onClick={() => setOpen(!open)}
      >
        <ModeIcon size={14} />
        <span>{tr(active.short)}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <ComposerPopover
          anchor={anchor}
          close={() => setOpen(false)}
          label={tr("Режим разрешений")}
          className="mode-popover"
          align="start"
        >
          {modes.map((item) => (
            <button
              key={item.id}
              className={item.id === "full" ? "full-access" : ""}
              role="menuitemradio"
              aria-checked={mode === item.id}
              disabled={pending}
              data-autofocus={mode === item.id ? "" : undefined}
              onClick={() => {
                setPending(true);
                void changeMode(item.id).finally(() => {
                  setPending(false);
                  setOpen(false);
                });
              }}
            >
              <item.icon size={16} />
              <span>
                <strong>{tr(item.name)}</strong>
                <small>{tr(item.description)}</small>
              </span>
              {mode === item.id && <Check size={15} />}
            </button>
          ))}
        </ComposerPopover>
      )}
    </div>
  );
}

const effortNames: Record<string, [number, string]> = {
  none: [0, "Off"],
  minimal: [1, "Minimal"],
  low: [2, "Low"],
  medium: [3, "Medium"],
  high: [4, "High"],
  xhigh: [5, "Extra High"],
  "extra-high": [5, "Extra High"],
  extra_high: [5, "Extra High"],
  max: [6, "Max"],
};
const variantName = (id: string) => effortNames[id.toLowerCase()]?.[1] ?? id;

export function ComposerModelControl({
  disabled,
  openCatalog,
}: {
  disabled: boolean;
  openCatalog: () => void;
}) {
  useLanguage();

  const { preferences, models } = useApp();
  const [menu, setMenu] = useState<"models" | "effort">();
  const anchor = useRef<HTMLDivElement>(null);
  const selected = models.find(
    (m) =>
      m.id === preferences.model?.id &&
      m.providerID === preferences.model.providerID,
  );
  const modelName =
    selected?.name ??
    (preferences.model
      ? `${preferences.model.providerID}/${preferences.model.id}`
      : tr("Выбрать модель"));
  const variants = [...new Set(selected?.variants ?? [])];
  const isEffort = variants.every((v) => !!effortNames[v.toLowerCase()]);
  // Custom provider variants need not be reasoning levels; retain their names and order.
  if (isEffort)
    variants.sort(
      (a, b) =>
        effortNames[a.toLowerCase()][0] - effortNames[b.toLowerCase()][0],
    );
  // OpenCode can return the implicit preset as "default" on an existing session.
  const current =
    preferences.model?.variant === "default" && !variants.includes("default")
      ? undefined
      : preferences.model?.variant;
  const index = current ? variants.indexOf(current) + 1 : 0;
  const label = current ? variantName(current) : tr("По умолчанию");
  const unavailable = !!current && !variants.includes(current);
  useEffect(() => {
    if (disabled) setMenu(undefined);
  }, [disabled]);
  function changeVariant(value?: string) {
    if (selected)
      void attempt(() =>
        savePreferences({
          model: {
            id: selected.id,
            providerID: selected.providerID,
            ...(value ? { variant: value } : {}),
          },
        }),
      );
  }
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        event.code === "KeyM" &&
        !disabled &&
        !document.querySelector(".modal-backdrop")
      ) {
        event.preventDefault();
        setMenu((value) => (value ? undefined : "effort"));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [disabled]);
  return (
    <div className="model-menu-anchor model-controls" ref={anchor}>
      <button
        className="model-select"
        aria-label={tr("Выбрать модель")}
        title={`${modelName} · Ctrl+Shift+M`}
        aria-expanded={!!menu}
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={() => setMenu(menu ? undefined : "effort")}
      >
        <span>{modelName}</span>
        {!variants.length && <ChevronDown size={12} />}
      </button>
      {!!variants.length && (
        <button
          className="effort-trigger"
          aria-label={
            isEffort ? tr("Настроить уровень мышления") : tr("Вариант модели")
          }
          title={`${isEffort ? tr("Уровень мышления") : tr("Вариант модели")}: ${label}`}
          disabled={disabled}
          aria-haspopup="dialog"
          aria-expanded={menu === "effort"}
          onClick={() => setMenu(menu === "effort" ? undefined : "effort")}
        >
          <span>{current ? variantName(current) : tr("Авто")}</span>
          <ChevronDown size={12} />
        </button>
      )}
      {menu === "models" && (
        <ComposerPopover
          key="models"
          anchor={anchor}
          close={() => setMenu(undefined)}
          label={tr("Выбор модели")}
          className="model-popover"
        >
          <div className="model-favorites-heading">
            <button
              className="model-back-button"
              aria-label={tr("Назад к мышлению")}
              onClick={() => setMenu("effort")}
            >
              <ArrowLeft size={13} />
            </button>
            <span>{tr("Закреплённые модели")}</span>
          </div>
          <div className="model-favorites-list">
            {!preferences.favoriteModels?.length && (
              <p className="model-popover-empty">
                {tr(
                  "Закрепите модели в каталоге, чтобы быстро выбирать их здесь.",
                )}
              </p>
            )}
            {preferences.favoriteModels?.map((favorite) => {
              const m = models.find(
                (item) =>
                  item.id === favorite.id &&
                  item.providerID === favorite.providerID,
              );
              const checked =
                selected?.id === favorite.id &&
                selected.providerID === favorite.providerID;
              return (
                <button
                  role="menuitem"
                  key={`${favorite.providerID}/${favorite.id}`}
                  disabled={!m?.enabled}
                  data-autofocus={checked ? "" : undefined}
                  onClick={() =>
                    void attempt(async () => {
                      await savePreferences({
                        model: checked
                          ? preferences.model
                          : {
                              id: favorite.id,
                              providerID: favorite.providerID,
                            },
                      });
                      setMenu(undefined);
                    })
                  }
                >
                  <span
                    className="favorite-model-name"
                    title={m?.name ?? favorite.id}
                  >
                    {m?.name ?? favorite.id}
                  </span>
                  <small
                    className="favorite-provider"
                    title={favorite.providerID}
                  >
                    {favorite.providerID}
                    {!m?.enabled ? tr(" · недоступна") : ""}
                  </small>
                  {checked && <Check size={15} />}
                </button>
              );
            })}
          </div>
          <button
            className="model-catalog-link"
            role="menuitem"
            onClick={() => {
              setMenu(undefined);
              openCatalog();
            }}
          >
            <Search size={14} />
            {tr("Найти и закрепить модели")}
          </button>
        </ComposerPopover>
      )}
      {menu === "effort" && (
        <ComposerPopover
          key="effort"
          anchor={anchor}
          close={() => setMenu(undefined)}
          label={isEffort ? tr("Уровень мышления") : tr("Вариант модели")}
          className="effort-popover"
          role="dialog"
        >
          <div className="effort-heading">
            <Zap size={16} />
            <div>
              <strong
                className={current && !unavailable ? "effort-active" : ""}
              >
                {variants.length ? label : tr("Мышление")}
              </strong>
              <button
                className="effort-model-link"
                aria-label={tr("Выбрать другую модель")}
                onClick={() => setMenu("models")}
                title={modelName}
              >
                <span>{modelName}</span>
                <ChevronRight size={12} />
              </button>
            </div>
            <IconButton
              label={tr("Сбросить уровень по умолчанию")}
              onClick={() => changeVariant()}
              disabled={!current || !variants.length}
            >
              <RotateCcw size={15} />
            </IconButton>
          </div>
          {unavailable && (
            <p className="effort-unavailable">
              {tr(
                "Сохранённый вариант недоступен. Выберите другой или сбросьте настройку.",
              )}
            </p>
          )}
          {!!variants.length ? (
            <>
              <EffortSlider
                value={index}
                max={variants.length}
                label={isEffort ? tr("Уровень мышления") : tr("Вариант модели")}
                valueText={label}
                defaultState={!current || unavailable}
                change={(value) => changeVariant(variants[value - 1])}
              />
              <div className="effort-endpoints">
                <span>{tr("Авто")}</span>
                <span>{variantName(variants.at(-1)!)}</span>
              </div>
            </>
          ) : (
            <p className="effort-unsupported">
              {selected
                ? tr("У этой модели нет настройки мышления.")
                : tr("Выберите модель, чтобы начать разговор.")}
            </p>
          )}
        </ComposerPopover>
      )}
    </div>
  );
}
