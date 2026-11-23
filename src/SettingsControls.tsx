import type { ReactNode } from "react";
import { Check, TriangleAlert, X } from "lucide-react";
import { IconButton, Modal } from "./components";
import { tr } from "./i18n";

export function SettingsHeading({
  title,
  description,
  close,
}: {
  title: string;
  description: string;
  close: () => void;
}) {
  return (
    <header className="settings-page-heading">
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <IconButton label={tr("Закрыть настройки")} onClick={close}>
        <X size={18} aria-hidden="true" />
      </IconButton>
    </header>
  );
}

export function SettingsMessage({
  kind,
  children,
}: {
  kind: "success" | "error";
  children: ReactNode;
}) {
  const Icon = kind === "success" ? Check : TriangleAlert;
  return (
    <p
      className="settings-message"
      data-kind={kind}
      role={kind === "success" ? "status" : "alert"}
    >
      <Icon size={14} aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

export function SettingsConfirmation({
  title,
  action,
  busy,
  destructive = false,
  close,
  confirm,
  children,
}: {
  title: string;
  action: string;
  busy: boolean;
  destructive?: boolean;
  close: () => void;
  confirm: () => void;
  children: ReactNode;
}) {
  const cancel = () => {
    if (!busy) close();
  };
  return (
    <Modal title={title} close={cancel} className="settings-confirm-dialog">
      <div className="dialog-body">
        {children}
        <div className="settings-confirm-actions">
          <button
            className="secondary"
            data-autofocus
            disabled={busy}
            onClick={cancel}
          >
            {tr("Отмена")}
          </button>
          <button
            className={
              destructive ? "secondary settings-destructive" : "primary"
            }
            disabled={busy}
            onClick={confirm}
          >
            {action}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function SettingRow({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="setting-row" id={`setting-${id}`} tabIndex={-1}>
      <div className="setting-copy">
        <label id={`label-${id}`}>{title}</label>
        <p>{description}</p>
      </div>
      {children && <div className="setting-control">{children}</div>}
    </div>
  );
}
export function Toggle({
  id,
  value,
  change,
}: {
  id: string;
  value: boolean;
  change: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-labelledby={`label-${id}`}
      className={`setting-switch ${value ? "on" : ""}`}
      onClick={() => change(!value)}
    >
      <span />
    </button>
  );
}

export function SettingsGroup({
  title,
  children,
  columns = false,
}: {
  title: string;
  children: ReactNode;
  columns?: boolean;
}) {
  return (
    <section
      className={`settings-section ${columns ? "settings-columns" : ""}`}
    >
      <h3>{title}</h3>
      <div>{children}</div>
    </section>
  );
}

export function SettingsDisclosure({
  id,
  title,
  children,
  focusableContainer = true,
}: {
  id: string;
  title: string;
  children: ReactNode;
  focusableContainer?: boolean;
}) {
  return (
    <details
      className="settings-group settings-disclosure"
      id={`setting-${id}`}
      tabIndex={focusableContainer ? -1 : undefined}
    >
      <summary>{title}</summary>
      <div>{children}</div>
    </details>
  );
}
