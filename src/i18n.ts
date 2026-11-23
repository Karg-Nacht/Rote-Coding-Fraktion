import { useSyncExternalStore } from "react";
import { translate, type Language } from "../shared/i18n";

let language: Language = "ru";
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function useLanguage() {
  return useSyncExternalStore(subscribe, () => language);
}
export function setLanguage(value: Language) {
  if (typeof document !== "undefined") document.documentElement.lang = value;
  if (language === value) return;
  language = value;
  listeners.forEach((listener) => listener());
}
// Call only for interface copy. Project/model names and message content stay untouched.
export const tr = (source: string) => translate(source, language);
export function trf(strings: TemplateStringsArray, ...values: unknown[]) {
  const key = strings
    .map((part, index) => part + (index < values.length ? `{${index}}` : ""))
    .join("");
  return tr(key).replace(/\{(\d+)\}/g, (_match, index) =>
    String(values[Number(index)]),
  );
}
