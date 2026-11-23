import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";
import english from "../shared/en.json";
import { translate } from "../shared/i18n";

test("English translations cover every interface literal and preserve interpolation placeholders", () => {
  const dictionary: Record<string, string> = english;
  for (const [source, target] of Object.entries(dictionary)) {
    assert.ok(target.trim(), `Empty translation for ${source}`);
    assert.deepEqual(
      target.match(/\{\d+\}/g)?.sort() ?? [],
      source.match(/\{\d+\}/g)?.sort() ?? [],
      source,
    );
  }
  for (const name of readdirSync("src").filter((name) =>
    name.endsWith(".tsx"),
  )) {
    const ast = ts.createSourceFile(
      name,
      readFileSync(`src/${name}`, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const visit = (node: ts.Node) => {
      let key: string | undefined;
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(ast) === "tr" &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      )
        key = node.arguments[0].text;
      if (
        ts.isTaggedTemplateExpression(node) &&
        node.tag.getText(ast) === "trf" &&
        ts.isTemplateExpression(node.template)
      )
        key =
          node.template.head.text +
          node.template.templateSpans
            .map((s, i) => `{${i}}${s.literal.text}`)
            .join("");
      if (key && /[А-Яа-яЁё]/.test(key))
        assert.ok(
          dictionary[key.trim()] !== undefined,
          `${name}: missing ${key}`,
        );
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
});

test("Locale lookup preserves Russian, whitespace and strings outside the interface dictionary", () => {
  assert.equal(translate("Настройки", "ru"), "Настройки");
  assert.equal(translate(" Настройки ", "en"), " Settings ");
  assert.equal(
    translate("Настройки моего проекта", "en"),
    "Настройки моего проекта",
  );
  assert.equal(
    translate("provider/model:custom-variant", "en"),
    "provider/model:custom-variant",
  );
});
