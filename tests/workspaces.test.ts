import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { LocalStorage } from "../electron/storage";
import { workspacePermissions } from "../shared/permissions";
import {
  containsSecret,
  memoryContext,
  searchableMessage,
  searchSnippet,
  workspaceOf,
} from "../shared/workspaces";

test("Chat always denies every tool category and legacy sessions stay Work", () => {
  assert.equal(workspaceOf({}), "work");
  assert.equal(workspaceOf({ metadata: { forgeWorkspace: "chat" } }), "chat");
  for (const mode of ["cautious", "autonomous", "full"] as const)
    assert.deepEqual(workspacePermissions("chat", mode), [
      { action: "*", resource: "*", effect: "deny" },
    ]);
  assert.equal(workspacePermissions("work", "full")[0].effect, "allow");
});

test("Manual memory survives restart, respects scope and rejects secrets and duplicate entries", () => {
  const directory = path.resolve(
    `.runtime/memory-tests/${crypto.randomUUID()}`,
  );
  const storage = new LocalStorage(directory);
  const a = storage.addProject(path.join(directory, "первый"));
  const b = storage.addProject(path.join(directory, "второй"));
  const common = storage.memorySave({
    scope: "global",
    text: "Отвечай по-русски",
  });
  const personal = storage.memorySave({
    scope: "project",
    projectId: a.id,
    text: "Сохраняй архитектуру",
  });
  assert.equal(
    storage.memorySave({ scope: "global", text: "отвечай по-русски" }).id,
    common.id,
  );
  assert.equal(storage.memoryList().length, 2);
  assert.deepEqual(
    storage.memoryList(b.id).map((entry) => entry.id),
    [common.id],
  );
  assert.ok(memoryContext(storage.memoryList(a.id)).includes(personal.text));
  assert.throws(
    () =>
      storage.memorySave({ scope: "global", text: "api_key=not-for-memory" }),
    /не сохраняет/,
  );
  assert.throws(
    () => storage.memorySave({ scope: "project", text: "без проекта" }),
    /проект/,
  );
  assert.throws(
    () => storage.memorySave({ scope: "global", text: "x".repeat(2001) }),
    /2000/,
  );
  storage.memorySave({
    id: personal.id,
    scope: "project",
    projectId: a.id,
    text: "Обновлённое правило",
  });
  storage.savePreferences({ workspace: "chat", memoryEnabled: true });
  storage.close();
  const restored = new LocalStorage(directory);
  assert.equal(restored.preferences().workspace, "chat");
  assert.equal(restored.preferences().memoryEnabled, true);
  assert.equal(
    restored.memoryList().find((entry) => entry.id === personal.id)?.text,
    "Обновлённое правило",
  );
  assert.ok(restored.memoryList().every((entry) => entry.source === "user"));
  restored.memoryRemove(common.id);
  assert.equal(restored.memoryList().length, 1);
  restored.memoryClear();
  assert.deepEqual(restored.memoryList(), []);
  restored.close();
});

test("Search extracts visible text only and Unicode snippets retain the match", () => {
  assert.equal(
    searchableMessage({
      type: "assistant",
      content: [
        { type: "reasoning", text: "hidden" },
        { type: "text", text: "Сохраняем проект" },
      ],
    }),
    "Сохраняем проект",
  );
  assert.equal(searchableMessage({ type: "tool", text: "secret log" }), "");
  assert.ok(
    searchSnippet(
      "А".repeat(200) + " Найденный проект " + "Б".repeat(200),
      "найденный",
    ).includes("Найденный"),
  );
  assert.ok(containsSecret("Bearer abcdefghijklmnopqrstuvwxyz"));
  assert.ok(containsSecret("-----BEGIN PRIVATE KEY-----"));
  assert.equal(containsSecret("Обсудим хранение API-ключей и паролей"), false);
});
