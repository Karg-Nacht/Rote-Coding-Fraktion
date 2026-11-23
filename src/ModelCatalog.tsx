import { tr, useLanguage, trf } from "./i18n";
import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, Cpu, FolderPlus, Image, Pin, Search, X } from "lucide-react";
import type { Model } from "../shared/types";
import {
  attempt,
  sameModel,
  selectDefaultModel,
  toggleFavoriteModel,
  useApp,
} from "./store";
import { IconButton, Modal } from "./components";
import "./history-dialogs.css";
import "./model-controls.css";

export function ModelCatalog({ close }: { close: () => void }) {
  useLanguage();

  const { models, preferences } = useApp();
  const [query, setQuery] = useState("");
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const favorites = preferences.favoriteModels ?? [];
  const pinned = (m: Model) => favorites.some((f) => sameModel(f, m));
  const filtered = models.filter(
    (m) =>
      (!pinnedOnly || pinned(m)) &&
      `${m.name} ${m.id} ${m.providerID}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  );
  const current = Math.min(selected, Math.max(0, filtered.length - 1));
  const virtual = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => list.current,
    estimateSize: () => 42,
    overscan: 8,
    getItemKey: (index) =>
      `${filtered[index].providerID}/${filtered[index].id}`,
  });
  useEffect(() => {
    virtual.scrollToIndex(current, { align: "auto" });
  }, [current, query, pinnedOnly]);
  const toggle = (m: Model) => attempt(() => toggleFavoriteModel(m));
  async function choose(m: Model | undefined) {
    if (!m?.enabled || busy) return;
    setBusy(true);
    await attempt(async () => {
      await selectDefaultModel(m);
      close();
    });
    setBusy(false);
  }
  return (
    <Modal
      title={tr("Каталог моделей")}
      headerless
      close={close}
      backdropClassName="history-backdrop"
      className="history-dialog model-catalog-dialog"
    >
      <div className="palette-input-line">
        <Search className="palette-search-icon" size={16} />
        <input
          ref={input}
          data-autofocus
          autoFocus
          role="combobox"
          aria-label={tr("Поиск моделей")}
          aria-expanded="true"
          aria-controls="catalog-results"
          aria-activedescendant={
            filtered.length ? `catalog-model-${current}` : undefined
          }
          placeholder={tr("Модель или провайдер…")}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setSelected(
                (current + (e.key === "ArrowDown" ? 1 : -1) + filtered.length) %
                  Math.max(1, filtered.length),
              );
            }
            if (e.key === "Enter") {
              e.preventDefault();
              if (!e.repeat) {
                if (e.shiftKey && filtered[current])
                  void toggle(filtered[current]);
                else void choose(filtered[current]);
              }
            }
          }}
        />
        <IconButton label={tr("Закрыть каталог моделей")} onClick={close}>
          <X size={15} />
        </IconButton>
      </div>
      <div className="catalog-context">
        <span>
          {tr("Каталог моделей ")}
          <span className="catalog-count">{filtered.length}</span>
        </span>
        <button
          className={pinnedOnly ? "active" : ""}
          aria-pressed={pinnedOnly}
          onClick={() => {
            setPinnedOnly(!pinnedOnly);
            setSelected(0);
            input.current?.focus();
          }}
        >
          <Pin size={11} />
          {tr("Закреплённые ")}
          <span>{favorites.length}</span>
        </button>
      </div>
      <div
        className="catalog-results"
        ref={list}
        id="catalog-results"
        role="listbox"
        aria-label={tr("Модели")}
      >
        {filtered.length ? (
          <div
            className="catalog-virtual-space"
            style={{ height: virtual.getTotalSize() }}
          >
            {virtual.getVirtualItems().map((item) => {
              const m = filtered[item.index],
                active = sameModel(preferences.model, m);
              return (
                <div
                  className={`catalog-model-row ${current === item.index ? "selected" : ""} ${!m.enabled ? "unavailable" : ""}`}
                  key={item.key}
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <button
                    id={`catalog-model-${item.index}`}
                    className="catalog-model-select"
                    role="option"
                    aria-selected={current === item.index}
                    aria-disabled={!m.enabled || busy}
                    onMouseMove={() => setSelected(item.index)}
                    onClick={() => void choose(m)}
                  >
                    <Cpu size={14} />
                    <span className="catalog-model-copy">
                      <span title={m.name}>{m.name}</span>
                      <small>
                        {m.enabled
                          ? m.context
                            ? trf`${Math.round(m.context / 1000)}K контекст`
                            : m.id
                          : tr("Недоступна")}
                        {!m.tools ? tr(" · без инструментов") : ""}
                      </small>
                    </span>
                    <span className="catalog-provider" title={m.providerID}>
                      {m.providerID}
                    </span>
                    {m.image && (
                      <Image
                        size={12}
                        aria-label={tr("Поддерживает изображения")}
                      />
                    )}
                    {active && <Check size={13} />}
                  </button>
                  <button
                    className={`catalog-pin ${pinned(m) ? "pinned" : ""}`}
                    aria-label={trf`${pinned(m) ? tr("Открепить") : tr("Закрепить")} модель ${m.name}`}
                    aria-pressed={pinned(m)}
                    title={
                      pinned(m)
                        ? tr("Открепить модель")
                        : tr("Закрепить модель")
                    }
                    onClick={() => void toggle(m)}
                  >
                    <Pin size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="palette-empty">
            <Cpu size={22} />
            <span>
              {models.length
                ? tr("Модели не найдены")
                : tr("Модели не загружены")}
            </span>
            <small>
              {models.length
                ? tr("Попробуйте другое название или провайдера.")
                : tr("Проверьте движок и подключения.")}
            </small>
          </div>
        )}
      </div>
      <div className="catalog-footer">
        <span>
          <kbd>↑ ↓</kbd> {tr(" выбрать ")}
          <kbd>Enter</kbd> {tr(" открыть ")}
          <kbd>Shift Enter</kbd> {tr(" закрепить")}
        </span>
        <button
          onClick={() => {
            close();
            useApp
              .getState()
              .set({ settings: true, settingsSection: "connections" });
          }}
        >
          <FolderPlus size={13} />
          {tr("Подключить провайдера")}
        </button>
      </div>
    </Modal>
  );
}
