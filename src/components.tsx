import { tr, useLanguage } from "./i18n";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
export function IconButton({
  label,
  children,
  onClick,
  active,
  disabled,
  className = "",
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  useLanguage();

  return (
    <button
      className={`icon-button ${active ? "active" : ""} ${className}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
export function FloatingPanel({
  position,
  close,
  children,
  label,
  className = "",
  role = "menu",
}: {
  position: { x: number; y: number };
  close: () => void;
  children: ReactNode;
  label: string;
  className?: string;
  role?: "menu" | "dialog";
}) {
  useLanguage();

  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  const [point, setPoint] = useState(position);
  useLayoutEffect(() => {
    const place = () => {
      const box = panel.current?.getBoundingClientRect();
      if (!box) return;
      const next = {
        x: Math.max(8, Math.min(position.x, innerWidth - box.width - 8)),
        y: Math.max(40, Math.min(position.y, innerHeight - box.height - 8)),
      };
      setPoint((old) => (old.x === next.x && old.y === next.y ? old : next));
    };
    place();
    const observer = new ResizeObserver(place);
    if (panel.current) observer.observe(panel.current);
    return () => observer.disconnect();
  }, [position.x, position.y]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    let restore = true;
    const items = () => [
      ...(panel.current?.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)",
      ) ?? []),
    ];
    items()[0]?.focus();
    const outside = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (
        !panel.current?.contains(target) &&
        !previous?.contains(target)
      ) {
        restore = false;
        closeRef.current();
      }
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      }
      if (event.key === "Tab") {
        restore = false;
        closeRef.current();
      }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const buttons = items();
        const index = buttons.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (index +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  buttons.length) %
                buttons.length;
        buttons[next]?.focus();
      }
    };
    const resize = () => closeRef.current();
    document.addEventListener("pointerdown", outside);
    panel.current?.addEventListener("keydown", keydown);
    window.addEventListener("resize", resize);
    const element = panel.current;
    return () => {
      document.removeEventListener("pointerdown", outside);
      element?.removeEventListener("keydown", keydown);
      window.removeEventListener("resize", resize);
      if (restore && previous?.isConnected) previous.focus();
    };
  }, []);
  return createPortal(
    <div
      ref={panel}
      className={`floating-panel ${className}`}
      style={{ left: point.x, top: point.y }}
      role={role}
      aria-label={label}
    >
      {children}
    </div>,
    document.body,
  );
}
export function Modal({
  title,
  children,
  close,
  wide = false,
  className = "",
  headerless = false,
  backdropClassName = "",
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  wide?: boolean;
  className?: string;
  headerless?: boolean;
  backdropClassName?: string;
}) {
  useLanguage();

  const ref = useRef<HTMLDivElement>(null);
  const previousFocus = useRef(document.activeElement as HTMLElement | null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const old = previousFocus.current;
    const autofocus =
      ref.current?.querySelector<HTMLElement>("[data-autofocus]");
    if (autofocus) autofocus.focus();
    else if (!ref.current?.contains(document.activeElement))
      ref.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) closeRef.current();
      if (event.key === "Tab") {
        const items = [
          ...(ref.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
          ) ?? []),
        ].filter((item) => item.getClientRects().length > 0);
        if (!items?.length) return;
        const first = items[0],
          last = items[items.length - 1];
        if (!ref.current?.contains(document.activeElement)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      old?.focus();
    };
  }, []);
  return createPortal(
    <div
      className={`modal-backdrop ${backdropClassName}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        className={`modal ${wide ? "wide" : ""} ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        {!headerless && (
          <header>
            <h2>{title}</h2>
            <IconButton label={tr("Закрыть")} onClick={close}>
              <X size={17} />
            </IconButton>
          </header>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}
export function Empty({ children }: { children: ReactNode }) {
  useLanguage();

  return <div className="empty-small">{children}</div>;
}
