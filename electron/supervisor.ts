import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { Service } from "@opencode/client/service";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import type { EngineStatus } from "../shared/types";
import { Redactor } from "./security";
import { READER_PERMISSIONS, REVIEW_PERMISSIONS } from "./agent-control";
import { REVIEW_INSTRUCTIONS } from "../shared/rcf";
import { activeMap, checkEngine, STABLE_ENGINE_VERSION } from "./engine-compatibility";

export type EngineSelection = { directory: string; binary: string; version?: string; digest?: string };
const exec = promisify(execFile);

export async function sha512(file: string) {
  const hash = createHash("sha512");
  for await (const block of createReadStream(file)) hash.update(block);
  return hash.digest("hex");
}

export class OpenCodeSupervisor {
  client?: OpenCodeClient;
  private raw?: OpenCodeClient;
  private operations = (_operation: string) => false;
  status: EngineStatus = { state: "stopped" };
  private starting?: Promise<OpenCodeClient>;
  private expected?: string;
  private digest?: string;
  private generation = 0;
  constructor(
    public directory: string,
    public binary: string,
    readonly redactor: Redactor,
    private changed: (status: EngineStatus) => void,
  ) {}
  get env(): Record<string, string> {
    return {
      XDG_DATA_HOME: path.join(this.directory, "data"),
      XDG_CONFIG_HOME: path.join(this.directory, "config"),
      XDG_STATE_HOME: path.join(this.directory, "state"),
      XDG_CACHE_HOME: path.join(this.directory, "cache"),
      OPENCODE_DISABLE_AUTOUPDATE: "true",
    };
  }
  get file() {
    return path.join(this.env.XDG_STATE_HOME, "opencode", "service.json");
  }
  configure(selection: EngineSelection) {
    this.directory = selection.directory;
    this.binary = selection.binary;
    this.expected = selection.version;
    this.digest = selection.digest;
    this.operations = () => false;
    this.status = { state: "stopped" };
    this.generation++;
  }
  supports(operation: string) {
    return this.operations(operation);
  }
  async assertIdle() {
    if (this.starting) throw new Error("Дождитесь завершения запуска OpenCode.");
    if (!this.raw) {
      const registered = await fs.stat(this.file).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
      if (registered) throw new Error("Не удалось проверить активные задачи OpenCode.");
      return;
    }
    const active = await this.raw.session.active({ signal: AbortSignal.timeout(5000) });
    if (!activeMap(active)) throw new Error("Не удалось проверить активные задачи OpenCode.");
    if (Object.keys(active).length) throw new Error("Сначала остановите активные задачи OpenCode.");
  }
  setStatus(status: EngineStatus) {
    this.status = { ...this.status, error: undefined, ...status, generation: this.generation };
    this.changed(this.status);
  }
  async ensure(fixture = false): Promise<OpenCodeClient> {
    if (this.client) return this.client;
    if (this.starting) return this.starting;
    this.starting = this.start(fixture);
    try {
      return await this.starting;
    } finally {
      this.starting = undefined;
    }
  }
  private async start(fixture: boolean): Promise<OpenCodeClient> {
    this.setStatus({ state: "starting" });
    let launched = false;
    try {
      await fs.access(this.binary);
      if (this.digest && (!(await fs.lstat(this.binary)).isFile() || await sha512(this.binary) !== this.digest))
        throw new Error("Контрольная сумма установленного движка не совпадает.");
      const result = await exec(this.binary, ["--version"], {
        windowsHide: true, timeout: 10000, maxBuffer: 8192, env: { ...process.env, ...this.env },
      });
      const version = result.stdout.trim().replace(/^opencode v?/i, "");
      if (!STABLE_ENGINE_VERSION.test(version) || !version.startsWith("2.") || (this.expected && this.expected !== version))
        throw new Error("Неподдерживаемая версия двоичного файла OpenCode.");
      this.setStatus({ state: "starting", version });
      const configFile = path.join(
        this.env.XDG_CONFIG_HOME,
        "opencode",
        "opencode.json",
      );
      await fs.mkdir(path.dirname(configFile), { recursive: true });
      const previous = await fs
        .readFile(configFile, "utf8")
        .catch((e: NodeJS.ErrnoException) => {
          if (e.code === "ENOENT") return "{}";
          throw e;
        });
      const config = JSON.parse(previous);
      const agents = {
        "rcf-reviewer": {
          name: "RCF Reviewer",
          description: "Independent evidence-only code review",
          mode: "subagent",
          system: REVIEW_INSTRUCTIONS,
          permissions: REVIEW_PERMISSIONS,
        },
        "rcf-reader": {
          name: "RCF Reader",
          description:
            "Read-only repository exploration without shell or delegation",
          mode: "subagent",
          permissions: READER_PERMISSIONS,
        },
      };
      // These reserved agents carry the security contract of RCF. Do not change
      // provider/model settings or any other custom agent configuration.
      config.agents ??= {};
      if (
        Object.entries(agents).some(
          ([id, definition]) =>
            JSON.stringify(config.agents[id]) !== JSON.stringify(definition),
        )
      ) {
        await fs.writeFile(
          `${configFile}.before-rcf-${Date.now()}.bak`,
          previous,
          { mode: 0o600 },
        );
        Object.assign(config.agents, agents);
        await fs.writeFile(
          `${configFile}.rcf-tmp`,
          JSON.stringify(config, null, 2),
          { mode: 0o600 },
        );
        await fs.rename(`${configFile}.rcf-tmp`, configFile);
      }
      const endpoint = await Service.ensure({
        file: this.file,
        version,
        command: [
          this.binary,
          "serve",
          "--service",
          "--hostname",
          "127.0.0.1",
          "--port",
          "0",
        ],
        env: this.env,
        onStart: () => { launched = true; },
      });
      if (
        !["127.0.0.1", "localhost", "[::1]"].includes(
          new URL(endpoint.url).hostname,
        )
      )
        throw new Error("OpenCode вернул внешний адрес сервиса.");
      if (!endpoint.auth)
        throw new Error("Сервис OpenCode запущен без авторизации.");
      this.redactor.add(endpoint.auth.password);
      const headers = Service.headers(endpoint);
      const client = OpenCode.make({
        baseUrl: endpoint.url,
        headers,
        fetch: (input, init) => fetch(input, { ...init, redirect: "error" }),
      });
      const info = await client.server.info({
        signal: AbortSignal.timeout(15000),
      });
      if (info.version !== version)
        throw new Error("Версия сервера не совпадает с версией двоичного файла.");
      this.raw = client;
      const verified = await checkEngine(client, new URL(endpoint.url), headers, version, fixture ? this.directory : undefined);
      this.operations = verified.supports;
      this.setStatus({ state: "starting", compatibility: verified.compatibility });
      if (verified.compatibility.state === "unchecked" || verified.compatibility.state === "incompatible")
        throw new Error("API OpenCode не прошло базовую проверку. Нужна проверенная версия движка или обновление RCF.");
      // Existing provider credentials stay in Main and are only used to redact errors.
      for (const entry of verified.supports("credential.list")
        ? await client.credential.list({ signal: AbortSignal.timeout(5000) }) : []) {
        if (entry.value.type === "key") this.redactor.add(entry.value.key);
        if (entry.value.type === "oauth") {
          this.redactor.add(entry.value.access);
          this.redactor.add(entry.value.refresh);
        }
      }
      this.client = OpenCode.make({ baseUrl: endpoint.url, headers, fetch: verified.fetch });
      this.setStatus({ state: "ready", version: info.version });
      return this.client;
    } catch (error) {
      if (launched) await Service.stop({ file: this.file, pty: "clear" }).then(() => {
        this.raw = undefined;
      }, () => {});
      this.setStatus({ state: "error", error: this.redactor.error(error) });
      throw error;
    }
  }
  async restart() {
    await this.stop();
    return this.ensure();
  }
  async stop() {
    await this.starting?.catch(() => {});
    this.client = undefined;
    await Service.stop({ file: this.file, pty: "clear" });
    this.raw = undefined;
    this.setStatus({ state: "stopped" });
  }
}
