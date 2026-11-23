import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { EngineUpdateInfo } from "../shared/engine-manager";
import { OpenCodeSupervisor, type EngineSelection } from "./supervisor";
import { Redactor } from "./security";
import { STABLE_ENGINE_VERSION } from "./engine-compatibility";
import { compareVersions, discoverEngine, downloadEngine, EngineVerificationError, nativePackage } from "./engine-download";

const slotSchema = z.object({
  id: z.uuid(),
  version: z.string().regex(STABLE_ENGINE_VERSION),
  digest: z.string().regex(/^[a-f0-9]{128}$/),
});
const targetSchema = z.union([z.literal("base"), slotSchema]);
const compatibilitySchema = z.object({
  state: z.enum(["compatible", "partial", "incompatible", "unchecked"]),
  canSend: z.boolean(),
  checks: z.array(z.object({
    feature: z.enum(["connection", "history", "messages", "stream", "tools", "permissions", "models", "diff", "agents"]),
    state: z.enum(["verified", "unavailable", "unchecked"]),
    detail: z.string().max(1000),
  })).max(9),
});
const stagedSchema = z.object({ slot: slotSchema, compatibility: compatibilitySchema });
const journalSchema = z.object({
  at: z.number().min(0).max(8.64e15), action: z.string().max(40), result: z.string().max(40),
});
const manifestSchema = z.object({
  active: targetSchema,
  previous: targetSchema.optional(),
  staged: stagedSchema.optional(),
  journal: z.array(journalSchema).max(24),
});
type Slot = z.infer<typeof slotSchema>;
type Target = z.infer<typeof targetSchema>;
type Manifest = z.infer<typeof manifestSchema>;
type Lifecycle = { engine: OpenCodeSupervisor; start(): Promise<void>; stop(): Promise<void> };

const defaultIO = {
  discover: discoverEngine,
  download: downloadEngine,
  supported: () => !!nativePackage(),
  async inspect(selection: EngineSelection) {
    const probe = new OpenCodeSupervisor(selection.directory, selection.binary, new Redactor(), () => {});
    probe.configure(selection);
    try {
      await probe.ensure(true);
      return probe.status.compatibility!;
    } catch (error) {
      const compatibility = probe.status.compatibility;
      if (compatibility?.state === "incompatible" || compatibility?.state === "unchecked") return compatibility;
      throw error;
    } finally {
      await probe.stop();
    }
  },
};

export class EngineManager {
  private manifest: Manifest = { active: "base", journal: [] };
  private latest?: string;
  private checkedAt?: number;
  private error?: string;
  private rejected?: EngineUpdateInfo["rejected"];
  private phase: EngineUpdateInfo["phase"] = "idle";

  constructor(
    private root: string,
    private base: EngineSelection,
    private external: boolean,
    private installed: () => string | undefined,
    private publish: (info: EngineUpdateInfo) => void,
    private io: typeof defaultIO = defaultIO,
  ) {}

  async load() {
    try {
      const file = await fs.readFile(path.join(this.root, "manager.json"), "utf8");
      this.manifest = manifestSchema.parse(JSON.parse(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.error = "manifest";
        this.manifest = { active: "base", journal: [] };
        // Keep the damaged receipt and prevent changes until it is inspected.
      }
    }
  }

  private directory(slot: Slot) {
    return path.join(this.root, "slots", slot.id);
  }

  private resolve(target: Target): EngineSelection {
    if (target === "base" || this.external) return this.base;
    return {
      directory: path.join(this.directory(target), "profile"),
      binary: path.join(this.directory(target), "opencode.exe"),
      version: target.version,
      digest: target.digest,
    };
  }

  selection() {
    return this.resolve(this.manifest.active);
  }

  info(): EngineUpdateInfo {
    const installed = this.installed() ?? this.selection().version;
    return {
      source: this.external ? "external" : this.manifest.active === "base" ? "bundled" : "managed",
      installed,
      latest: this.latest,
      checkedAt: this.checkedAt,
      available: !!(installed && this.latest && compareVersions(this.latest, installed) > 0),
      canInstall: !this.external && this.error !== "manifest" && this.io.supported(),
      staged: this.external || !this.manifest.staged ? undefined :
        { version: this.manifest.staged.slot.version, compatibility: this.manifest.staged.compatibility },
      rejected: this.rejected,
      previous: this.external || !this.manifest.previous ? undefined : this.resolve(this.manifest.previous).version,
      phase: this.phase,
      error: this.error,
      journal: this.manifest.journal,
    };
  }

  private setPhase(phase: EngineUpdateInfo["phase"]) {
    this.phase = phase;
    this.publish(this.info());
  }

  private async record(action: string, result: string, change?: Partial<Omit<Manifest, "journal">>) {
    const manifest = {
      ...this.manifest,
      ...change,
      journal: [...this.manifest.journal, { at: Date.now(), action, result }].slice(-24),
    };
    // Checking for updates remains possible if the receipt needs repair.
    if (this.error === "manifest") return;
    await fs.mkdir(this.root, { recursive: true });
    const draft = path.join(this.root, "manager-" + randomUUID() + ".tmp");
    try {
      await fs.writeFile(draft, JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
      await fs.rename(draft, path.join(this.root, "manager.json"));
      this.manifest = manifest;
    } finally {
      await fs.rm(draft, { force: true }).catch(() => {});
    }
  }

  private async log(action: string, result: string) {
    await this.record(action, result).catch(() => {
      if (!this.error) this.error = "journal";
    });
  }

  async check() {
    if (this.phase !== "idle") return this.info();
    if (this.error !== "manifest") this.error = undefined;
    this.setPhase("checking");
    try {
      this.latest = await this.io.discover();
      this.checkedAt = Date.now();
      await this.log("check", this.info().available ? "available" : "checked");
    } catch {
      if (this.error !== "manifest") this.error = "registry";
      await this.log("check", "registry");
    } finally {
      this.setPhase("idle");
    }
    return this.info();
  }

  async stage() {
    const info = this.info();
    if (this.phase !== "idle" || !info.canInstall || !info.available || !info.latest) return info;
    this.error = undefined;
    this.rejected = undefined;
    const version = info.latest;
    const id = randomUUID();
    const directory = path.join(this.root, "slots", id);
    let failure = "download";
    this.setPhase("downloading");
    try {
      await fs.mkdir(directory, { recursive: true });
      const digest = await this.io.download(version, directory);
      const slot = slotSchema.parse({ id, version, digest });
      failure = "candidate";
      this.setPhase("testing");
      const compatibility = await this.io.inspect({
        directory: path.join(directory, "probe"),
        binary: this.resolve(slot).binary,
        version,
        digest,
      });
      if (compatibility.state !== "compatible" && compatibility.state !== "partial") {
        failure = "api";
        this.rejected = { version, compatibility };
        throw new Error("Incompatible candidate");
      }
      failure = "journal";
      await this.record("install", compatibility.state, { staged: { slot, compatibility } });
    } catch (error) {
      if (error instanceof EngineVerificationError) failure = error.reason;
      this.error = failure;
      await this.log("install", failure);
    } finally {
      this.setPhase("idle");
    }
    return this.info();
  }

  async activate(lifecycle: Lifecycle, rollback = false) {
    const target = rollback ? this.manifest.previous : this.manifest.staged?.slot;
    if (this.phase !== "idle" || this.external || this.error === "manifest" || !target) return this.info();
    const before = this.manifest.active;
    const original = this.resolve(before);
    const next = this.resolve(target);
    const action = rollback ? "rollback" : "switch";
    this.error = undefined;
    this.setPhase(rollback ? "rollback" : "switching");
    let stopped = false;
    let configured = false;
    let failure = "stop";
    try {
      await lifecycle.stop();
      stopped = true;
      if (!rollback) {
        failure = "journal";
        // Consume the staged slot before touching its profile. Even after an
        // interrupted migration, it cannot be reused as a clean candidate.
        await this.record(action, "preparing", { staged: undefined });
        failure = "backup";
        await copyEngineProfile(original.directory, next.directory);
      }
      failure = "activation";
      lifecycle.engine.configure(next);
      configured = true;
      await lifecycle.start();
      failure = "journal";
      await this.record(action, "ready", { active: target, previous: before });
    } catch {
      this.error = failure;
      // The manifest still refers to the original profile. A new attempt uses a
      // new slot so a failed migration can never be mistaken for a clean copy.
      if (stopped) {
        try {
          if (configured) await lifecycle.stop();
          lifecycle.engine.configure(original);
          await lifecycle.start();
        } catch {
          this.error = "recovery";
        }
      }
      await this.log(action, this.error);
    } finally {
      this.setPhase("idle");
    }
    return this.info();
  }
}

export async function copyEngineProfile(source: string, destination: string) {
  await fs.mkdir(destination);
  for (const component of ["data", "config", "state"] as const) {
    const input = path.join(source, component);
    const exists = await fs.lstat(input).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (exists) await fs.cp(input, path.join(destination, component), {
      recursive: true,
      force: false,
      errorOnExist: true,
      async filter(entry) {
        const relative = path.relative(input, entry).replaceAll(path.sep, "/").toLowerCase();
        if (relative === "opencode/service.json" || relative === "opencode/log") return false;
        const info = await fs.lstat(entry);
        if (!info.isDirectory() && !info.isFile()) throw new Error("Unsupported engine profile entry");
        return true;
      },
    });
  }
}
