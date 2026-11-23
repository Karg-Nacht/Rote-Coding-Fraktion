import { Check, Pin, Search } from "lucide-react";
import { useState } from "react";
import { tr, useLanguage } from "./i18n";
import {
  attempt,
  sameModel,
  savePreferences,
  selectDefaultModel,
  toggleFavoriteModel,
  useApp,
} from "./store";
import { SettingsDisclosure, SettingsGroup } from "./SettingsControls";
import { ModelCatalog } from "./ModelCatalog";
import { CustomSelect } from "./CustomSelect";
import { ConnectionsSettings } from "./ConnectionsSettings";
import "./model-settings.css";

export function ModelSettings() {
  useLanguage();

  const { preferences, models } = useApp();
  const [catalogOpen, setCatalogOpen] = useState(false);
  const current = preferences.model;
  const selected = models.find((item) => sameModel(current, item));
  const favorites = preferences.favoriteModels ?? [];
  const pinned = current && favorites.some((item) => sameModel(item, current));
  const variants = [...new Set(selected?.variants)];
  const variant =
    current?.variant === "default" && !variants.includes("default")
      ? ""
      : (current?.variant ?? "");
  const name = selected?.name ?? current?.id ?? tr("Модель не выбрана");

  return (
    <div className="model-settings">
      <SettingsGroup title={tr("Текущая модель")}>
        <div className="current-model" id="setting-default-model" tabIndex={-1}>
          <div className="current-model-copy">
            <strong title={name}>{name}</strong>
            {current && (
              <>
                <div className="current-model-meta">
                  <small title={current.providerID}>{current.providerID}</small>
                  {(variants.length > 0 || variant) && (
                    <>
                      <span aria-hidden="true">·</span>
                      <CustomSelect
                        id="setting-reasoning"
                        className="model-variant"
                        aria-label={tr("Вариант модели")}
                        title={tr("Вариант модели")}
                        value={variant}
                        onChange={(value) => {
                          void attempt(() =>
                            savePreferences({
                              model: {
                                ...current,
                                variant: value || undefined,
                              },
                            }),
                          );
                        }}
                        options={[
                          { value: "", label: tr("По умолчанию") },
                          ...(variant && !variants.includes(variant)
                            ? [{ value: variant, label: `${variant} · ${tr("Недоступна")}`, disabled: true }]
                            : []),
                          ...variants.map((value) => ({ value, label: value })),
                        ]}
                      />
                    </>
                  )}
                </div>
                {name !== current.id && (
                  <small className="current-model-id" title={current.id}>
                    {current.id}
                  </small>
                )}
              </>
            )}
          </div>
          <button
            className="secondary model-settings-search"
            aria-label={tr("Найти модель…")}
            title={tr("Найти модель…")}
            onClick={() => setCatalogOpen(true)}
          >
            <Search size={14} aria-hidden="true" />
            {tr("Найти")}
          </button>
          {current && (
            <button
              className="icon-button model-settings-pin"
              aria-label={tr("Закрепить модель")}
              aria-pressed={!!pinned}
              title={tr(pinned ? "Открепить модель" : "Закрепить модель")}
              onClick={() => void attempt(() => toggleFavoriteModel(current))}
            >
              <Pin size={15} />
            </button>
          )}
        </div>
        <SettingsDisclosure
          id="favorites"
          title={`${tr("Закреплённые модели")} · ${favorites.length}`}
        >
          {favorites.length ? (
            <div className="model-settings-favorites">
              {favorites.map((favorite) => {
                const model = models.find((item) => sameModel(favorite, item));
                const active = sameModel(current, favorite);
                return (
                  <button
                    key={JSON.stringify([favorite.providerID, favorite.id])}
                    aria-pressed={active}
                    disabled={!model?.enabled}
                    onClick={() =>
                      void attempt(() => selectDefaultModel(favorite))
                    }
                  >
                    <span>
                      <strong title={favorite.id}>
                        {model?.name ?? favorite.id}
                      </strong>
                      <small>
                        {favorite.providerID}
                        {!model?.enabled && ` · ${tr("Недоступна")}`}
                      </small>
                    </span>
                    {active && <Check size={14} aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="hint">
              {tr("Закрепите текущую модель или найдите другую через поиск.")}
            </p>
          )}
        </SettingsDisclosure>
      </SettingsGroup>
      <ConnectionsSettings />
      {catalogOpen && <ModelCatalog close={() => setCatalogOpen(false)} />}
    </div>
  );
}
