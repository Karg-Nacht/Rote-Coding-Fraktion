import { createContext, useContext, useEffect, useState } from "react";
import { api, attempt } from "./store";

type DisplayState = { hidden: boolean; open: Set<string> };
type Display = DisplayState & {
  ready: boolean;
  toggle: (id: string) => void;
  setHidden: (hidden: boolean) => void;
};

export const ActivityDisplay = createContext<Display | null>(null);
const initial: DisplayState = { hidden: false, open: new Set() };

export function useActivityDisplay(sessionId: string): Display {
  const key = `activity:${sessionId}`;
  const [state, setState] = useState<DisplayState>(initial);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let mounted = true;
    void attempt(async () => {
      const saved = await api.loadDraft(key);
      if (!mounted || !saved) return;
      let value;
      try {
        value = JSON.parse(saved);
      } catch {
        return;
      }
      const open = Array.isArray(value?.open)
        ? value.open.filter((id: unknown) => typeof id === "string")
        : [];
      setState({ hidden: value?.hidden === true, open: new Set(open) });
    }).finally(() => {
      if (mounted) setReady(true);
    });
    return () => {
      mounted = false;
    };
  }, [key]);

  function update(next: DisplayState) {
    if (!ready) return;
    setState(next);
    void attempt(() =>
      api.saveDraft(
        key,
        JSON.stringify({
          hidden: next.hidden,
          open: [...next.open].slice(-1500),
        }),
      ),
    );
  }

  return {
    ...state,
    ready,
    setHidden: (hidden) => update({ ...state, hidden }),
    toggle: (id) => {
      const open = new Set(state.open);
      if (open.has(id)) open.delete(id);
      else open.add(id);
      update({ ...state, open });
    },
  };
}

export function useActivityDisclosure(id: string) {
  const display = useContext(ActivityDisplay)!;
  return { open: display.open.has(id), toggle: () => display.toggle(id) };
}
