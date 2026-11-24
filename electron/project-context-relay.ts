import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";

export const PROJECT_CONTEXT_HOOK = "rcf-project-context";
export const PROJECT_CONTEXT_METADATA = "rcfProjectContext";
export const PROJECT_CONTEXT_CHAT = "rcfChatMessage";
const EVIDENCE_TTL = 10 * 60_000;

// OpenCode loads this hook from RCF's private engine config. Its only inputs
// are the latest user message's RCF metadata and that session's prepared evidence.
const hook = `export default {
  id: ${JSON.stringify(PROJECT_CONTEXT_HOOK)},
  async setup({ session }) {
    const guardChat = async (event) => {
      const latest = event.messages.findLast((message) => message.role === "user" && !message.metadata?.instruction);
      if (!latest?.metadata?.${PROJECT_CONTEXT_CHAT}) return;
      // OpenCode normally includes discovered project instructions and replays
      // their updates. Chat uses the current app guidance and opted-in evidence.
      for (const part of event.system) {
        const sources = part.metadata?.experimental?.instructions;
        if (Array.isArray(sources)) part.text = sources
          .filter(({ key }) => key !== "core/instructions" && key !== "api/forge-user-context")
          .map(({ text }) => text).join("\\n\\n");
      }
      event.messages = event.messages.filter((message) =>
        !message.metadata?.instruction && (message.role !== "system" || message.id !== undefined),
      );
      const entries = await session.instructions.entry.list({ sessionID: event.sessionID });
      const guidance = entries.find(({ key }) => key === "forge-user-context")?.value;
      if (typeof guidance === "string" && guidance) event.system.push({ text: guidance });
      return latest;
    };
    const registration = await session.hook("context", async (event) => {
      const latest = await guardChat(event);
      const context = latest?.metadata?.${PROJECT_CONTEXT_METADATA};
      if (!context) return;
      const { port, token } = context;
      if (!Number.isInteger(port) || port < 1 || port > 65535 ||
          typeof token !== "string" || !/^[0-9a-f-]{36}$/.test(token))
        throw new Error("Invalid RCF Project Intelligence request.");
      const response = await fetch("http://127.0.0.1:" + port + "/rcf-project-evidence", {
        method: "POST",
        headers: { "X-RCF-Context": token, "X-RCF-Session": event.sessionID },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error("RCF Project Intelligence evidence is no longer available.");
      const evidence = await response.text();
      if (!Array.isArray(latest.content)) throw new Error("Unsupported RCF Project Intelligence message.");
      latest.content.push({ type: "text", text: "\\n\\n" + evidence });
    });
    const compaction = await session.hook("compaction", async (event) => { await guardChat(event); });
    return async () => { await registration.dispose(); await compaction.dispose(); };
  },
};\n`;

export function projectContextHookPath(configDirectory: string) {
  return path.join(
    configDirectory,
    "opencode",
    "plugins",
    `${PROJECT_CONTEXT_HOOK}.js`,
  );
}

export async function installProjectContextHook(configDirectory: string) {
  const file = projectContextHookPath(configDirectory);
  if ((await fs.readFile(file, "utf8").catch(() => "")) === hook) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, hook, { flag: "wx", mode: 0o600 });
  await fs.rename(temporary, file);
}

export class ProjectContextRelay {
  private server?: Server;
  private listening?: Promise<number>;
  private leases = new Map<
    string,
    {
      sessionId: string;
      evidence: string;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  private listen() {
    if (this.listening) return this.listening;
    const server = createServer((request, response) => {
      const token = request.headers["x-rcf-context"];
      const lease =
        typeof token === "string" ? this.leases.get(token) : undefined;
      if (
        request.method !== "POST" ||
        request.url !== "/rcf-project-evidence" ||
        !lease ||
        request.headers["x-rcf-session"] !== lease.sessionId
      ) {
        response.writeHead(404).end();
        return;
      }
      response
        .writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        })
        .end(lease.evidence);
    });
    this.server = server;
    this.listening = new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Не удалось открыть канал контекста проекта."));
          return;
        }
        server.unref();
        resolve(address.port);
      });
    }).catch((error) => {
      if (this.server === server) {
        this.server = undefined;
        this.listening = undefined;
      }
      throw error;
    });
    return this.listening;
  }

  async acquire(sessionId: string, evidence: string) {
    const port = await this.listen();
    if (this.leases.size >= 16)
      throw new Error("Слишком много запросов контекста. Повторите попытку.");
    const token = randomUUID();
    const release = () => {
      const entry = this.leases.get(token);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.leases.delete(token);
    };
    this.leases.set(token, {
      sessionId,
      evidence,
      timer: setTimeout(release, EVIDENCE_TTL).unref(),
    });
    return { port, token, release };
  }

  close() {
    for (const entry of this.leases.values()) clearTimeout(entry.timer);
    this.leases.clear();
    this.server?.close();
    this.server?.closeAllConnections();
    this.server = undefined;
    this.listening = undefined;
  }
}
