import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { MemoryEntry, Preferences, Project } from "../shared/types";
import {
  containsSecret,
  MEMORY_LIMIT,
  MEMORY_TEXT_LIMIT,
} from "../shared/workspaces";

export class LocalStorage {
  private db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, "forge.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, name TEXT NOT NULL, collapsed INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pins(session TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS drafts(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_directories(directory TEXT PRIMARY KEY, projectId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory(id TEXT PRIMARY KEY, scope TEXT NOT NULL, projectId TEXT, text TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL);`);
  }
  projects(): Project[] {
    return (
      this.db
        .prepare("SELECT * FROM projects ORDER BY rowid")
        .all() as unknown as Project[]
    ).map((p) => ({
      ...p,
      collapsed: !!p.collapsed,
      section: this.get<{ section?: string }>(`project:${p.id}`, {}).section,
      managed: this.get<{ managed?: boolean }>(`project:${p.id}`, {}).managed,
    }));
  }
  project(id: string): Project {
    const p = this.projects().find((p) => p.id === id);
    if (!p) throw new Error("Проект недоступен. Добавьте папку заново.");
    return p;
  }
  taskDirectories(projectId: string): string[] {
    return (
      this.db
        .prepare("SELECT directory FROM task_directories WHERE projectId=?")
        .all(projectId) as { directory: string }[]
    ).map((r) => r.directory);
  }
  bindDirectory(projectId: string, directory: string) {
    this.project(projectId);
    const current = this.db
      .prepare("SELECT projectId FROM task_directories WHERE directory=?")
      .get(directory) as { projectId: string } | undefined;
    if (current && current.projectId !== projectId)
      throw new Error("Рабочая папка уже связана с другим проектом.");
    this.db
      .prepare(
        "INSERT OR IGNORE INTO task_directories(directory,projectId) VALUES(?,?)",
      )
      .run(directory, projectId);
  }
  addProject(directory: string): Project {
    const existing = this.projects().find(
      (p) =>
        path.resolve(p.path).toLowerCase() ===
        path.resolve(directory).toLowerCase(),
    );
    if (existing) return existing;
    const p = {
      id: randomUUID(),
      path: directory,
      name: path.basename(directory),
      collapsed: false,
    };
    this.db
      .prepare("INSERT INTO projects(id,path,name) VALUES(?,?,?)")
      .run(p.id, p.path, p.name);
    return p;
  }
  removeProject(id: string) {
    this.db.prepare("DELETE FROM projects WHERE id=?").run(id);
    this.db.prepare("DELETE FROM settings WHERE key=?").run(`project:${id}`);
    const prefs = this.preferences();
    this.savePreferences({
      pinnedProjects: (prefs.pinnedProjects ?? []).filter(
        (value) => value !== id,
      ),
      ...(prefs.projectId === id
        ? { projectId: undefined, sessionId: undefined }
        : {}),
    });
  }
  sectionProject(id: string, section: string): Project {
    this.project(id);
    this.set(`project:${id}`, { ...this.get(`project:${id}`, {}), section });
    return this.project(id);
  }
  collapseProject(id: string, collapsed: boolean) {
    this.db
      .prepare("UPDATE projects SET collapsed=? WHERE id=?")
      .run(+collapsed, id);
  }
  renameProject(id: string, name: string): Project {
    this.project(id);
    this.db.prepare("UPDATE projects SET name=? WHERE id=?").run(name, id);
    return this.project(id);
  }
  get<T>(key: string, fallback: T): T {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : fallback;
  }
  set(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  preferences(): Preferences {
    return {
      language: "ru",
      workspace: "work",
      memoryEnabled: false,
      ...this.get<Preferences>("preferences", {
        mode: "cautious",
        sidebarWidth: 260,
      }),
    };
  }
  savePreferences(value: Partial<Preferences>) {
    this.set("preferences", { ...this.preferences(), ...value });
  }
  pinned(id: string): boolean {
    return !!this.db
      .prepare("SELECT session FROM pins WHERE session=?")
      .get(id);
  }
  pin(id: string, pinned: boolean) {
    if (pinned)
      this.db.prepare("INSERT OR IGNORE INTO pins(session) VALUES(?)").run(id);
    else this.db.prepare("DELETE FROM pins WHERE session=?").run(id);
  }
  draft(key: string): string {
    const saved = (
      this.db.prepare("SELECT value FROM drafts WHERE key=?").get(key) as
        { value: string } | undefined
    )?.value;
    if (saved !== undefined) return saved;
    // Keep unsent Work drafts from the version before workspace separation.
    if (key.startsWith("new:work:")) return this.draft(`new:${key.slice(9)}`);
    return "";
  }
  chatMeta(id: string): { unread?: boolean; section?: string } {
    return this.get(`chat:${id}`, {});
  }
  setChatMeta(id: string, value: { unread?: boolean; section?: string }) {
    this.set(`chat:${id}`, { ...this.chatMeta(id), ...value });
  }
  forgetChat(id: string) {
    this.pin(id, false);
    this.db.prepare("DELETE FROM settings WHERE key=?").run(`chat:${id}`);
    this.db
      .prepare("DELETE FROM drafts WHERE key IN (?,?)")
      .run(id, `scroll:${id}`);
    if (this.preferences().sessionId === id)
      this.savePreferences({ sessionId: undefined });
  }
  saveDraft(key: string, text: string) {
    this.db
      .prepare(
        "INSERT INTO drafts(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, text);
  }
  memoryList(projectId?: string): MemoryEntry[] {
    if (projectId) this.project(projectId);
    const rows = (projectId
      ? this.db
          .prepare(
            "SELECT * FROM memory WHERE scope='global' OR projectId=? ORDER BY updated DESC",
          )
          .all(projectId)
      : this.db
          .prepare("SELECT * FROM memory ORDER BY updated DESC")
          .all()) as unknown as Omit<MemoryEntry, "source">[];
    return rows.map((row) => ({
      ...row,
      projectId: row.projectId ?? undefined,
      source: "user",
    }));
  }
  memorySave(input: {
    id?: string;
    scope: "global" | "project";
    projectId?: string;
    text: string;
  }): MemoryEntry {
    if (input.scope !== "global" && input.scope !== "project")
      throw new Error("Недопустимая область памяти.");
    const text = input.text.trim();
    if (!text || text.length > MEMORY_TEXT_LIMIT)
      throw new Error(
        `Запись памяти должна содержать от 1 до ${MEMORY_TEXT_LIMIT} символов.`,
      );
    if (containsSecret(text))
      throw new Error(
        "Память не сохраняет пароли, токены и API-ключи. Удалите секрет из записи.",
      );
    const projectId = input.scope === "project" ? input.projectId : undefined;
    if (input.scope === "project") {
      if (!projectId) throw new Error("Выберите проект для записи памяти.");
      this.project(projectId);
    }
    const entries = this.memoryList();
    const previous = input.id
      ? entries.find((entry) => entry.id === input.id)
      : undefined;
    if (input.id && !previous) throw new Error("Запись памяти не найдена.");
    const duplicate = entries.find(
      (entry) =>
        entry.id !== input.id &&
        entry.scope === input.scope &&
        entry.projectId === projectId &&
        entry.text.toLocaleLowerCase() === text.toLocaleLowerCase(),
    );
    if (duplicate) {
      if (input.id) throw new Error("Такая запись памяти уже существует.");
      return duplicate;
    }
    if (!previous && entries.length >= MEMORY_LIMIT)
      throw new Error(
        `Можно сохранить не более ${MEMORY_LIMIT} записей. Удалите ненужные записи.`,
      );
    if (
      entries
        .filter((entry) => entry.id !== input.id)
        .reduce((total, entry) => total + entry.text.length, 0) +
        text.length >
      24000
    )
      throw new Error(
        "Общий объём памяти ограничен 24 000 символами. Сократите существующие записи.",
      );
    const entry: MemoryEntry = {
      id: previous?.id ?? randomUUID(),
      scope: input.scope,
      projectId,
      text,
      created: previous?.created ?? Date.now(),
      updated: Date.now(),
      source: "user",
    };
    this.db
      .prepare(
        "INSERT INTO memory(id,scope,projectId,text,created,updated) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET scope=excluded.scope,projectId=excluded.projectId,text=excluded.text,updated=excluded.updated",
      )
      .run(
        entry.id,
        entry.scope,
        entry.projectId ?? null,
        entry.text,
        entry.created,
        entry.updated,
      );
    return entry;
  }
  memoryRemove(id: string) {
    this.db.prepare("DELETE FROM memory WHERE id=?").run(id);
  }
  memoryClear() {
    this.db.prepare("DELETE FROM memory").run();
  }
  close() {
    this.db.close();
  }
}
