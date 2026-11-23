import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import diff from "@shikijs/langs/diff";
import dark from "@shikijs/themes/github-dark-default";
import light from "@shikijs/themes/github-light-default";
import { diffLines } from "../shared/diff";
const highlighter = createHighlighterCore({
  themes: [dark, light],
  langs: [diff],
  engine: createJavaScriptRegexEngine(),
});
export async function highlightDiff(text: string, compact = false) {
  const lines = diffLines(text);
  return (await highlighter).codeToHtml(text, {
    lang: "diff",
    themes: { dark: "github-dark-default", light: "github-light-default" },
    defaultColor: "dark",
    transformers: [
      {
        line(node, line) {
          const info = lines[line - 1];
          this.addClassToHast(node, "diff-line");
          this.addClassToHast(node, `diff-${info.kind}`);
          node.properties["data-old"] = info.old ?? "";
          node.properties["data-new"] = info.next ?? "";
          node.properties["data-diff-kind"] = info.kind;
        },
        code(node) {
          if (
            compact &&
            lines.some((line) =>
              ["context", "add", "delete"].includes(line.kind),
            )
          )
            node.children = node.children.filter(
              (child) =>
                child.type === "element" &&
                ["context", "add", "delete"].includes(
                  String(child.properties["data-diff-kind"]),
                ),
            );
        },
      },
    ],
  });
}
