import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import dark from "@shikijs/themes/github-dark-default";
import light from "@shikijs/themes/github-light-default";

const grammars = {
  javascript: () => import("@shikijs/langs/javascript"),
  typescript: () => import("@shikijs/langs/typescript"),
  python: () => import("@shikijs/langs/python"),
  json: () => import("@shikijs/langs/json"),
  shellscript: () => import("@shikijs/langs/shellscript"),
};
const aliases: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  py: "python",
  bash: "shellscript",
  sh: "shellscript",
  shell: "shellscript",
};
let highlighter: ReturnType<typeof createHighlighterCore> | undefined;
const pending = new Map<string, Promise<void>>();

export async function highlightCode(text: string, language: string) {
  const requested = language.toLowerCase();
  const name = aliases[requested] ?? requested;
  if (!Object.hasOwn(grammars, name)) return;
  highlighter ??= createHighlighterCore({
    themes: [dark, light],
    engine: createJavaScriptRegexEngine(),
  });
  const engine = await highlighter;
  const key = name as keyof typeof grammars;
  if (!pending.has(key)) pending.set(key, engine.loadLanguage(grammars[key]()));
  await pending.get(key);
  return engine.codeToHtml(text, {
    lang: key,
    themes: { dark: "github-dark-default", light: "github-light-default" },
    defaultColor: "dark",
    tabindex: 0,
  });
}
