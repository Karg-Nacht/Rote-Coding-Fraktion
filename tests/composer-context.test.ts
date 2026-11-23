import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { folderContext } from "../electron/folder-context";
import { taskPermissions } from "../shared/permissions";
import { LocalStorage } from "../electron/storage";

test("Planning denies mutations, shell and external tools in every permission mode; Chat remains fully denied", () => {
  for (const mode of ["cautious", "autonomous", "full"] as const) {
    const rules = taskPermissions("work", mode, true);
    const effect = (action: string, resource = "*") =>
      rules
        .filter(
          (r) =>
            (r.action === "*" || r.action === action) &&
            r.resource === resource,
        )
        .at(-1)?.effect;
    for (const action of [
      "shell",
      "edit",
      "subagent",
      "webfetch",
      "mcp.write",
      "external_directory",
    ])
      assert.equal(effect(action), "deny");
    assert.equal(effect("read"), "allow");
    assert.equal(effect("read", "*.env"), "ask");
    assert.deepEqual(taskPermissions("chat", mode, true), [
      { action: "*", resource: "*", effect: "deny" },
    ]);
  }
});
test("Folder context is a bounded snapshot of names, skips secrets, dependency folders and Windows junctions", async () => {
  const root = path.resolve(`.runtime/folder-context-${crypto.randomUUID()}`),
    outside = root + "-outside";
  await fs.mkdir(path.join(root, "вложенная"), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, "outside-secret"), "NEVER_READ");
  await fs.symlink(outside, path.join(root, "junction"), "junction");
  await fs.writeFile(path.join(root, "readme.txt"), "CONTENTS_MUST_NOT_APPEAR");
  await fs.writeFile(path.join(root, ".env.local"), "SECRET");
  await fs.mkdir(path.join(root, "node_modules"));
  await fs.writeFile(path.join(root, "вложенная", "код.ts"), "SOURCE");
  const first = new TextDecoder().decode((await folderContext(root)).bytes);
  assert.match(first, /readme.txt/);
  assert.match(first, /код.ts/);
  assert.doesNotMatch(
    first,
    /CONTENTS_MUST_NOT_APPEAR|SECRET|SOURCE|junction|outside-secret|\.env.local|node_modules/,
  );
  await Promise.all(
    Array.from({ length: 250 }, (_, i) =>
      fs.writeFile(path.join(root, `item-${i}.txt`), ""),
    ),
  );
  const bounded = new TextDecoder().decode((await folderContext(root)).bytes);
  assert.match(bounded, /limited to 200 entries/);
  assert.ok(bounded.split("\n").length <= 205);
});
test("Managed task directories and draft options persist without corrupting project metadata", () => {
  const directory = path.resolve(
    `.runtime/managed-context-${crypto.randomUUID()}`,
  );
  const db = new LocalStorage(directory),
    project = db.addProject(path.join(directory, "tasks", "unique"));
  db.set(`project:${project.id}`, { managed: true });
  db.sectionProject(project.id, "Local");
  db.saveDraft(
    "options:new:work:composer",
    JSON.stringify({ planning: true, skills: ["exact-skill"] }),
  );
  db.close();
  const restored = new LocalStorage(directory);
  assert.equal(restored.project(project.id).managed, true);
  assert.equal(restored.project(project.id).section, "Local");
  assert.deepEqual(JSON.parse(restored.draft("options:new:work:composer")), {
    planning: true,
    skills: ["exact-skill"],
  });
  restored.close();
});
