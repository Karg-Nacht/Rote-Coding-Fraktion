import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ConversationMarker, Snapshot } from "../shared/types";
import { api, useApp } from "./store";
import { tr } from "./i18n";
import "./conversation-rail.css";

export function ConversationRail({
  snapshot,
  visibleIndex,
}: {
  snapshot: Snapshot;
  visibleIndex: number;
}) {
  const id = snapshot.session.id;
  const [history, setHistory] = useState<ConversationMarker[]>([]);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [preview, setPreview] = useState<{
    marker: ConversationMarker;
    top: number;
    right: number;
  }>();
  const suppressPreview = useRef(false);
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    setHistory([]);
    setError(false);
    setPreview(undefined);
    // Only request older metadata when the snapshot is paginated. Each IPC response
    // is bounded and cancellation stops the next page after a chat switch.
    if (snapshot.olderCursor)
      void (async () => {
        let cursor: string | undefined;
        const seen = new Set<string>();
        try {
          do {
            const page = await api.conversationIndex(id, cursor);
            if (!active) return;
            setHistory((items) => [...items, ...page.items]);
            cursor = page.next ?? undefined;
            if (cursor && seen.has(cursor)) break;
            if (cursor) seen.add(cursor);
          } while (cursor && active);
        } catch {
          if (active) setError(true);
        }
      })();
    return () => {
      active = false;
    };
  }, [id, revision]);
  const markers = useMemo(() => {
    const firstLoadedAt = snapshot.rows[0]?.at ?? Infinity;
    const items = new Map(
      history
        .filter((item) => item.at < firstLoadedAt)
        .map((item) => [item.id, item]),
    );
    for (const row of snapshot.rows)
      if (row.type === "user")
        items.set(row.id, {
          id: row.id,
          at: row.at,
          text:
            row.text.slice(0, 320) ||
            row.attachments?.map((a) => a.name).join(", ") ||
            tr("Вложения"),
        });
    return [...items.values()].sort(
      (a, b) => a.at - b.at || a.id.localeCompare(b.id),
    );
  }, [history, snapshot.rows]);
  const activeId = useMemo(() => {
    for (let i = Math.min(visibleIndex, snapshot.rows.length - 1); i >= 0; i--)
      if (snapshot.rows[i].type === "user") return snapshot.rows[i].id;
    return markers[0]?.id;
  }, [visibleIndex, snapshot.rows, markers]);
  const virtual = useVirtualizer({
    count: markers.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 20,
    getItemKey: (i) => markers[i].id,
    overscan: 3,
  });
  useEffect(() => {
    const index = markers.findIndex((m) => m.id === activeId);
    if (index >= 0) virtual.scrollToIndex(index, { align: "auto" });
  }, [activeId, markers.length]);
  if (!markers.length) return null;
  return (
    <nav
      className="conversation-rail"
      aria-label={tr("Навигация по сообщениям")}
      onMouseLeave={() => {
        setPreview(undefined);
        suppressPreview.current = false;
      }}
      onMouseMove={() => {
        suppressPreview.current = false;
      }}
    >
      {error && (
        <button
          className="rail-retry"
          title={tr("Повторить загрузку истории")}
          onClick={() => setRevision((n) => n + 1)}
        >
          ↻
        </button>
      )}
      <div className="rail-scroll" ref={scroll}>
        <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
          {virtual.getVirtualItems().map((item) => {
            const marker = markers[item.index];
            const show = (element: HTMLElement) =>
              !suppressPreview.current &&
              setPreview({
                marker,
                right: innerWidth - element.getBoundingClientRect().left + 10,
                top: Math.max(
                  12,
                  Math.min(
                    innerHeight - 170,
                    element.getBoundingClientRect().top - 20,
                  ),
                ),
              });
            return (
              <button
                key={marker.id}
                className="rail-marker"
                style={{ transform: `translateY(${item.start}px)` }}
                aria-label={`${tr("Сообщение")} ${item.index + 1}: ${marker.text.slice(0, 80)}`}
                aria-current={marker.id === activeId ? "location" : undefined}
                aria-describedby={
                  preview?.marker.id === marker.id ? "rail-preview" : undefined
                }
                onMouseEnter={(e) => show(e.currentTarget)}
                onFocus={(e) => show(e.currentTarget)}
                onBlur={() => setPreview(undefined)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setPreview(undefined);
                  if (["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
                    e.preventDefault();
                    const next =
                      e.key === "Home"
                        ? 0
                        : e.key === "End"
                          ? markers.length - 1
                          : Math.max(
                              0,
                              Math.min(
                                markers.length - 1,
                                item.index + (e.key === "ArrowUp" ? -1 : 1),
                              ),
                            );
                    virtual.scrollToIndex(next);
                    requestAnimationFrame(() =>
                      scroll.current
                        ?.querySelector<HTMLButtonElement>(
                          `[data-marker-index="${next}"]`,
                        )
                        ?.focus(),
                    );
                  }
                }}
                data-marker-index={item.index}
                onClick={() => {
                  suppressPreview.current = true;
                  setPreview(undefined);
                  useApp.getState().set({
                    searchTarget: {
                      sessionId: id,
                      messageId: marker.id,
                      query: "",
                    },
                  });
                }}
              >
                <span />
              </button>
            );
          })}
        </div>
      </div>
      {preview && (
        <div
          id="rail-preview"
          role="tooltip"
          className="rail-preview"
          style={{ top: preview.top, right: preview.right }}
        >
          <small>{new Date(preview.marker.at).toLocaleString()}</small>
          <p>{preview.marker.text}</p>
        </div>
      )}
    </nav>
  );
}
