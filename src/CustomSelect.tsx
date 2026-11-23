import { ChevronDown, Check } from "lucide-react";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import "./custom-select.css";

export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
  group?: string;
};

type Selection =
  | { multiple?: false; value: string; onChange: (value: string) => void }
  | {
      multiple: true;
      value: readonly string[];
      onChange: (value: string[]) => void;
    };

type Props = Selection & {
  options: readonly SelectOption[];
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  title?: string;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
};

export function CustomSelect(props: Props) {
  const { options, disabled, required, placeholder = "" } = props;
  const id = useId();
  const triggerId = props.id ?? id;
  const listId = `${id}-list`;
  const optionId = (index: number) => `${id}-option-${index}`;
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLSpanElement>(null);
  const search = useRef({ text: "", time: 0 });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [error, setError] = useState("");
  const expanded = open && !disabled;
  const selected = props.multiple ? props.value : [props.value];
  const hasValue = options.some(
    (option) =>
      !option.disabled && option.value && selected.includes(option.value),
  );
  const enabled = options.flatMap((option, index) =>
    option.disabled ? [] : [index],
  );
  const selectedIndex = enabled.find((index) =>
    selected.includes(options[index].value),
  );
  const caption =
    options
      .filter((option) => selected.includes(option.value))
      .map((option) => option.label)
      .join(", ") || placeholder;

  function openList(index = selectedIndex ?? enabled[0] ?? -1) {
    search.current = { text: "", time: 0 };
    setActive(index);
    setOpen(true);
  }

  function choose(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    setError("");
    if (props.multiple) {
      const next = selected.includes(option.value)
        ? selected.filter((value) => value !== option.value)
        : [...selected, option.value];
      props.onChange(next);
    } else {
      setOpen(false);
      if (option.value !== props.value) props.onChange(option.value);
    }
  }

  useLayoutEffect(() => {
    if (!expanded || !trigger.current || !list.current) return;
    const anchor = trigger.current;
    const popup = list.current;
    const dialog = anchor.closest('[role="dialog"]');
    const header = dialog?.querySelector(":scope > header");
    const footer = dialog?.querySelector("[data-select-footer]");
    const titlebar = document.querySelector(".titlebar");
    const position = () => {
      const rect = anchor.getBoundingClientRect();
      const edge = 8;
      const gap = 5;
      const width = Math.min(Math.max(rect.width, 164), innerWidth - edge * 2);
      popup.style.width = `${width}px`;
      const topEdge = Math.max(
        (titlebar?.getBoundingClientRect().bottom ?? 0) + edge,
        header?.getBoundingClientRect().bottom ?? 0,
      );
      const bottomEdge = Math.min(
        innerHeight - edge,
        footer?.getBoundingClientRect().top ?? innerHeight,
      );
      const below = bottomEdge - rect.bottom - gap;
      const above = rect.top - gap - topEdge;
      const preferred = Math.min(popup.scrollHeight, 320);
      const flip = below < preferred && above > below;
      popup.style.maxHeight = `${Math.max(0, Math.min(320, flip ? above : below))}px`;
      popup.style.left = `${Math.max(edge, Math.min(rect.left, innerWidth - width - edge))}px`;
      popup.style.top = flip ? "auto" : `${rect.bottom + gap}px`;
      popup.style.bottom = flip ? `${innerHeight - rect.top + gap}px` : "auto";
      popup.dataset.side = flip ? "above" : "below";
    };
    const outside = (event: PointerEvent) => {
      if (
        !event.composedPath().includes(anchor) &&
        !event.composedPath().includes(popup)
      ) {
        setOpen(false);
      }
    };
    popup.showPopover();
    position();
    const resize = new ResizeObserver(position);
    resize.observe(anchor);
    const intersection = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) setOpen(false);
    });
    intersection.observe(anchor);
    const scroll = (event: Event) => {
      if (event.target !== popup) position();
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", scroll, true);
    return () => {
      if (popup.matches(":popover-open")) popup.hidePopover();
      resize.disconnect();
      intersection.disconnect();
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [expanded, options.length]);

  useLayoutEffect(() => {
    if (!expanded || active < 0) return;
    const popup = list.current;
    const option = document.getElementById(optionId(active));
    if (!popup || !option) return;
    const bounds = popup.getBoundingClientRect();
    const row = option.getBoundingClientRect();
    if (row.top < bounds.top + popup.clientTop) {
      popup.scrollTop += row.top - bounds.top - popup.clientTop - 4;
    } else if (row.bottom > bounds.top + popup.clientTop + popup.clientHeight) {
      popup.scrollTop +=
        row.bottom - bounds.top - popup.clientTop - popup.clientHeight + 4;
    }
  }, [expanded, active, id]);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (event.key === "Escape") {
      if (!expanded) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (
      ["Enter", " ", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Enter" || event.key === " ") {
        if (expanded) choose(active);
        else openList();
        return;
      }
      const direction = event.key === "ArrowUp" ? -1 : 1;
      const edge = direction === 1 ? enabled[0] : enabled.at(-1);
      let index = selectedIndex ?? edge;
      if (event.key === "Home") index = enabled[0];
      else if (event.key === "End") index = enabled.at(-1);
      else if (expanded && enabled.length) {
        const current = enabled.indexOf(active);
        index =
          current < 0
            ? edge
            : enabled[(current + direction + enabled.length) % enabled.length];
      }
      if (expanded) setActive(index ?? -1);
      else openList(index);
      return;
    }
    if (
      event.key.length !== 1 ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.nativeEvent.isComposing
    )
      return;
    event.preventDefault();
    const now = performance.now();
    const letter = event.key.toLocaleLowerCase();
    const previous = now - search.current.time < 700 ? search.current.text : "";
    const prefix = previous === letter ? letter : previous + letter;
    search.current = { text: prefix, time: now };
    const current = enabled.indexOf(expanded ? active : (selectedIndex ?? -1));
    const offset = prefix.length === 1 ? current + 1 : Math.max(0, current);
    const order = enabled.slice(offset).concat(enabled.slice(0, offset));
    const match = order.find((index) =>
      options[index].label.toLocaleLowerCase().startsWith(prefix),
    );
    if (expanded) {
      if (match !== undefined) setActive(match);
    } else {
      setActive(match ?? selectedIndex ?? enabled[0] ?? -1);
      setOpen(true);
    }
  }

  const groups: { label?: string; indices: number[] }[] = [];
  options.forEach((option, index) => {
    const group = groups.at(-1);
    if (group && group.label === option.group) group.indices.push(index);
    else groups.push({ label: option.group, indices: [index] });
  });
  const rows = (indices: number[]) =>
    indices.map((index) => {
      const option = options[index];
      const checked = selected.includes(option.value);
      return (
        <span
          key={option.value}
          id={optionId(index)}
          role="option"
          aria-selected={checked}
          aria-disabled={option.disabled || undefined}
          data-option-value={option.value}
          data-active={active === index || undefined}
          className="custom-select-option"
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.preventDefault();
            trigger.current?.focus();
            choose(index);
          }}
        >
          <span>{option.label}</span>
          {checked && <Check size={14} aria-hidden="true" />}
        </span>
      );
    });

  return (
    <>
      <button
        type="button"
        ref={trigger}
        id={triggerId}
        className={`custom-select ${props.className ?? ""}`}
        role="combobox"
        aria-label={props["aria-label"]}
        aria-labelledby={props["aria-labelledby"]}
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={
          expanded && active >= 0 ? optionId(active) : undefined
        }
        aria-required={required || undefined}
        aria-invalid={(!hasValue && !!error) || undefined}
        aria-describedby={!hasValue && error ? `${id}-error` : undefined}
        title={props.title ?? caption}
        data-value={props.multiple ? undefined : props.value}
        disabled={disabled}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
        onClick={() => (expanded ? setOpen(false) : openList())}
      >
        <span>{caption}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <span
        ref={list}
        id={listId}
        className="custom-select-list"
        popover="manual"
        role="listbox"
        aria-hidden={!expanded || undefined}
        aria-labelledby={props["aria-labelledby"] ?? triggerId}
        aria-label={props["aria-label"]}
        aria-multiselectable={props.multiple || undefined}
      >
        {groups.map(({ label, indices }) =>
          label === undefined ? (
            rows(indices)
          ) : (
            <span key={indices[0]} role="group" aria-label={label}>
              <span className="custom-select-group-label" aria-hidden="true">
                {label}
              </span>
              {rows(indices)}
            </span>
          ),
        )}
      </span>
      {required && (
        <input
          className="custom-select-validation"
          aria-hidden="true"
          tabIndex={-1}
          required
          disabled={disabled}
          value={hasValue ? "1" : ""}
          onChange={() => {}}
          onInvalid={(event) => {
            event.preventDefault();
            const field = event.currentTarget;
            setError(field.validationMessage);
            if (field.form?.querySelector(":invalid") === field) {
              trigger.current?.focus();
              openList();
            }
          }}
        />
      )}
      {!hasValue && error && (
        <small id={`${id}-error`} role="alert" className="custom-select-error">
          {error}
        </small>
      )}
    </>
  );
}
