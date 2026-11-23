import english from "./en.json";
export type Language = "ru" | "en";
export function translate(source: string, language: Language = "ru"): string {
  if (language !== "en") return source;
  const key = source.trim();
  const value = (english as Record<string, string>)[key];
  return value === undefined ? source : source.replace(key, () => value);
}
