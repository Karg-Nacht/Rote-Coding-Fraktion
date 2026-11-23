import {
  useLayoutEffect,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

export function ComposerSurface({
  open,
  anchor,
  alignTo,
  close,
  label,
  children,
  className = "",
}: {
  open: boolean;
  anchor: RefObject<HTMLElement | null>;
  alignTo?: RefObject<HTMLElement | null>;
  close: () => void;
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const [mounted, setMounted] = useState(open);
  const [point, setPoint] = useState<{
    left: number;
    top: number;
    width?: number;
    maxHeight?: number;
  }>({ left: 0, top: 40 });
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  const content = useRef(children);
  if (open) content.current = children;
  useEffect(() => {
    if (open) setMounted(true);
    else {
      const timer = setTimeout(() => setMounted(false), 130);
      return () => clearTimeout(timer);
    }
  }, [open]);
  useLayoutEffect(() => {
    if (!mounted || !open) return;
    const place = () => {
      const aligned = alignTo?.current?.getBoundingClientRect();
      if (aligned && panel.current) {
        const width = Math.min(aligned.width, innerWidth - 16);
        const maxHeight = Math.max(32, Math.min(328, aligned.top - 46));
        panel.current.style.width = `${width}px`;
        panel.current.style.maxHeight = `${maxHeight}px`;
        const next = {
          left: Math.max(8, Math.min(aligned.left, innerWidth - width - 8)),
          top: Math.max(40, aligned.top - panel.current.offsetHeight - 5),
          width,
          maxHeight,
        };
        setPoint((old) =>
          old.left === next.left &&
          old.top === next.top &&
          old.width === width &&
          old.maxHeight === maxHeight
            ? old
            : next,
        );
        return;
      }
      const trigger = anchor.current?.getBoundingClientRect(),
        box = panel.current
          ? {
              width: panel.current.offsetWidth,
              height: panel.current.offsetHeight,
            }
          : undefined;
      if (!trigger || !box) return;
      const next = {
        left: Math.max(8, Math.min(trigger.left, innerWidth - box.width - 8)),
        top: Math.max(
          42,
          Math.min(trigger.top - box.height - 9, innerHeight - box.height - 8),
        ),
      };
      setPoint((old) =>
        old.left === next.left && old.top === next.top ? old : next,
      );
    };
    place();
    const observer = new ResizeObserver(place);
    if (panel.current) observer.observe(panel.current);
    if (alignTo?.current) observer.observe(alignTo.current);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [mounted, open, anchor, alignTo]);
  useEffect(() => {
    if (!mounted || !open) return;
    const previous = document.activeElement as HTMLElement | null;
    let restore = true;
    const timer = requestAnimationFrame(() =>
      (
        panel.current?.querySelector<HTMLElement>("[data-autofocus]") ??
        panel.current?.querySelector<HTMLElement>("button:not(:disabled)")
      )?.focus(),
    );
    const outside = (event: PointerEvent) => {
      if (
        !panel.current?.contains(event.target as Node) &&
        !anchor.current?.contains(event.target as Node)
      ) {
        restore = false;
        closeRef.current();
      }
    };
    const keys = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      }
      if (
        ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) &&
        !(
          event.target instanceof HTMLInputElement &&
          ["Home", "End"].includes(event.key)
        )
      ) {
        const items = [
          ...panel.current!.querySelectorAll<HTMLButtonElement>(
            "[data-panel-item]:not(:disabled)",
          ),
        ];
        if (!items.length) return;
        event.preventDefault();
        const at = items.indexOf(document.activeElement as HTMLButtonElement);
        const selected =
          items[
            at < 0
              ? event.key === "ArrowDown"
                ? 0
                : items.length - 1
              : (at + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
                items.length
          ];
        const target =
          event.key === "Home"
            ? items[0]
            : event.key === "End"
              ? items.at(-1)
              : selected;
        target?.focus();
        target?.scrollIntoView({ block: "nearest" });
      }
      if (event.key === "Tab") {
        const items = [
          ...panel.current!.querySelectorAll<HTMLElement>(
            "input, button:not(:disabled), textarea, select",
          ),
        ].filter((el) => el.getClientRects().length);
        if (
          document.activeElement === (event.shiftKey ? items[0] : items.at(-1))
        ) {
          restore = false;
          closeRef.current();
        }
      }
    };
    panel.current?.addEventListener("keydown", keys);
    document.addEventListener("pointerdown", outside);
    const element = panel.current;
    return () => {
      cancelAnimationFrame(timer);
      document.removeEventListener("pointerdown", outside);
      element?.removeEventListener("keydown", keys);
      if (
        restore &&
        previous?.isConnected &&
        (!document.activeElement ||
          document.activeElement === document.body ||
          element?.contains(document.activeElement))
      )
        previous.focus();
    };
  }, [mounted, open, anchor]);
  if (!mounted) return null;
  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label={label}
      className={`composer-surface ${className} ${open ? "is-open" : "is-closing"}`}
      style={point}
      inert={!open || undefined}
    >
      {open ? children : content.current}
    </div>,
    document.body,
  );
}
