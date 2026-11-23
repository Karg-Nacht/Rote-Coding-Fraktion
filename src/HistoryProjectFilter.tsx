import { tr, useLanguage, trf } from "./i18n";
import { useState } from "react";
import { Check, ChevronDown, Folder } from "lucide-react";
import { FloatingPanel } from "./components";
import type { Project } from "../shared/types";

export function HistoryProjectFilter({
  projects,
  value,
  onChange,
}: {
  projects: Project[];
  value: string;
  onChange: (value: string) => void;
}) {
  useLanguage();

  const [point, setPoint] = useState<{ x: number; y: number }>();
  const label = projects.find((p) => p.id === value)?.name ?? tr("Все проекты");
  return (
    <>
      <button
        className={`history-project-filter ${value ? "filtered" : ""}`}
        aria-label={trf`Проект для поиска: ${label}`}
        aria-expanded={!!point}
        aria-haspopup="menu"
        data-menu-trigger
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          setPoint(
            point ? undefined : { x: box.right - 250, y: box.bottom + 7 },
          );
        }}
      >
        <Folder size={12} />
        <span>{label}</span>
        <ChevronDown size={11} />
      </button>
      {point && (
        <FloatingPanel
          label={tr("Проекты для поиска")}
          position={point}
          close={() => setPoint(undefined)}
          className="history-project-menu"
        >
          {[{ id: "", name: tr("Все проекты") }, ...projects.filter(p => !p.managed)].map((p) => (
            <button
              key={p.id}
              role="menuitemradio"
              aria-checked={value === p.id}
              onClick={() => {
                onChange(p.id);
                setPoint(undefined);
              }}
            >
              <Folder size={14} />
              <span>{p.name}</span>
              {value === p.id && <Check size={13} />}
            </button>
          ))}
        </FloatingPanel>
      )}
    </>
  );
}
