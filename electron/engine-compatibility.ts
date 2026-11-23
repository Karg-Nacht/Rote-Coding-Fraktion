import type { OpenCodeClient } from "@opencode/client";
import type { EngineCapability, EngineCheck, EngineCompatibility } from "../shared/engine-manager";

// Expand only after the release passes RCF's local provider, tool and permission
// integration fixtures. A matching OpenAPI document alone cannot establish semantics.
export const ENGINE_CONTRACTS = new Set(["2.3.0", "2.3.2"]);
export const BASE_ENGINE_VERSION = "2.3.0";
export const STABLE_ENGINE_VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;

const requirements = {
  history: ["session.list", "session.get", "session.active", "session.message.list"],
  messages: ["session.create", "session.prompt", "session.interrupt", "session.inbox.list", "session.inbox.cancel"],
  permissions: ["permission.request.list", "session.permission.list", "session.permission.reply", "session.update"],
  tools: ["session.prompt", "session.form.list", "session.form.get", "session.form.reply"],
  models: ["model.list", "provider.list", "integration.list", "credential.list"],
  diff: ["session.diff", "vcs.get"],
  agents: ["agent.list", "session.create", "worktree.list"],
} as const;
type Contract = { id: string; method: string; route: RegExp };

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function readOperations(document: unknown): Contract[] {
  const paths = object(object(document)?.paths);
  if (!paths) return [];
  return Object.entries(paths).flatMap(([path, operations]) => {
    if (!path.startsWith("/api/") || !object(operations)) return [];
    const route = new RegExp(`^${path.split(/(\{[^{}]+\})/).map((part, index) =>
      index % 2 ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ).join("")}$`);
    return Object.entries(object(operations)!).flatMap(([method, entry]) => {
      const id = object(entry)?.operationId;
      return typeof id === "string" ? [{ id, method: method.toUpperCase(), route }] : [];
    });
  });
}

export function sessionPage(value: unknown) {
  const page = object(value);
  return !!page && !!object(page.cursor) && Array.isArray(page.data) && page.data.every(sessionRecord);
}

function sessionRecord(value: unknown) {
  const entry = object(value);
  return typeof entry?.id === "string" &&
    typeof object(entry.location)?.directory === "string" &&
    Number.isFinite(object(entry.time)?.updated);
}

export function activeMap(value: unknown) {
  const entries = object(value);
  return !!entries && Object.values(entries).every((entry) => object(entry)?.type === "running");
}

type Probe = "ok" | "failed" | "skipped";
async function probe(run: (signal: AbortSignal) => Promise<unknown>, valid: (result: unknown) => boolean): Promise<Probe> {
  try {
    return valid(await run(AbortSignal.timeout(4000))) ? "ok" : "failed";
  } catch {
    return "failed";
  }
}

export async function checkEngine(client: OpenCodeClient, base: URL, headers: RequestInit["headers"], version: string, fixture?: string, fetcher = fetch) {
  const get = (path: string, signal: AbortSignal) =>
    fetcher(new URL(path, base), { headers, signal, redirect: "error" });
  const operations = await (async () => {
    try {
      const response = await get("/openapi.json", AbortSignal.timeout(4000));
      return response.ok ? readOperations(await response.json()) : [];
    } catch { return []; }
  })();
  const ids = new Set(operations.map(({ id }) => id));
  const supports = (operation: string) => ids.has(operation);
  const known = ENGINE_CONTRACTS.has(version);
  const [history, active, stream, permissions, models, providers, integrations, agents] = await Promise.all([
    probe((signal) => client.session.list({ limit: 1 }, { signal }), sessionPage),
    probe((signal) => client.session.active({ signal }), activeMap),
    probe(async (signal) => {
      const response = await get("/api/event", signal);
      const content = response.headers.get("content-type");
      if (!response.ok || !content?.startsWith("text/event-stream") || !response.body) {
        void response.body?.cancel();
        return false;
      }
      const reader = response.body.getReader();
      try {
        let head = "";
        const decoder = new TextDecoder();
        while (head.length < 8192) {
          const { value, done } = await reader.read();
          if (done) break;
          head += decoder.decode(value, { stream: true });
          if (/^data:.*"type"\s*:\s*"server.connected"/m.test(head)) return true;
        }
        return false;
      } finally {
        void reader.cancel().catch(() => {});
      }
    }, (value) => value === true),
    probe((signal) => client.permission.request.list(undefined, { signal }), (value) => Array.isArray(object(value)?.data)),
    probe((signal) => client.model.list(undefined, { signal }), (value) => Array.isArray(object(value)?.data)),
    probe((signal) => client.provider.list(undefined, { signal }), (value) => Array.isArray(object(value)?.data)),
    probe((signal) => client.integration.list(undefined, { signal }), (value) => Array.isArray(object(value)?.data)),
    probe((signal) => client.agent.list(undefined, { signal }), (value) => Array.isArray(object(value)?.data)),
  ]);
  let historyRead: Probe = "skipped";
  let diffRead: Probe = "skipped";
  try {
    const page = await client.session.list({ limit: 1 }, { signal: AbortSignal.timeout(4000) });
    const id = fixture && supports("session.create")
      ? (await client.session.create({
        title: "RCF compatibility probe",
        location: { directory: fixture },
        permissions: [{ action: "*", resource: "*", effect: "deny" }],
      }, { signal: AbortSignal.timeout(4000) })).id
      : page.data[0]?.id;
    if (id) {
      const [record, messages, diff] = await Promise.all([
        probe((signal) => client.session.get({ sessionID: id }, { signal }), sessionRecord),
        probe((signal) => client.message.list({ sessionID: id, limit: 1 }, { signal }),
          (value) => !!object(object(value)?.cursor) && Array.isArray(object(value)?.data)),
        supports("session.diff")
          ? probe((signal) => client.session.diff({ sessionID: id }, { signal }), Array.isArray)
          : Promise.resolve<Probe>("skipped"),
      ]);
      historyRead = record === "ok" && messages === "ok" ? "ok" : "failed";
      diffRead = diff;
    } else if (fixture) {
      historyRead = "failed";
    }
  } catch {
    if (fixture) historyRead = "failed";
  }
  const checks: EngineCheck[] = [{ feature: "connection", state: "verified", detail: "server.info" }];
  function check(feature: EngineCapability, routes: readonly string[], result: Probe, reference = false) {
    const missing = routes.filter((route) => !supports(route));
    checks.push({
      feature,
      state: missing.length || result === "failed" ? "unavailable" : result === "ok" || reference ? "verified" : "unchecked",
      detail: missing.length ? missing.join(", ") : result === "failed" ? "probe-failed" :
        result === "ok" ? "probe-passed" : reference ? "rcf-reference" : "schema-only",
    });
  }
  check("history", requirements.history, history === "failed" || active === "failed" || historyRead === "failed" ? "failed" : "ok");
  check("stream", ["event.subscribe"], stream);
  check("messages", requirements.messages, "skipped", known);
  check("tools", requirements.tools, "skipped", known);
  check("permissions", requirements.permissions, permissions === "failed" ? "failed" : "skipped", known);
  check("models", requirements.models, [models, providers, integrations].every((value) => value === "ok") ? "ok" : "failed");
  check("diff", requirements.diff, diffRead, known);
  check("agents", requirements.agents, agents === "failed" ? "failed" : "skipped", known);
  const verified = (feature: EngineCapability) => checks.some((check) => check.feature === feature && check.state === "verified");
  const state: EngineCompatibility["state"] = !operations.length ? "unchecked" :
    !verified("history") ? "incompatible" :
    checks.every((check) => check.state === "verified") ? "compatible" : "partial";
  const compatibility: EngineCompatibility = {
    state, checks,
    canSend: known && (["history", "messages", "stream", "tools", "permissions", "models"] as const).every(verified),
  };
  return { compatibility, supports, fetch: guardEngineFetch(base, operations, compatibility, known) };
}

export function guardEngineFetch(base: URL, operations: Contract[], compatibility: EngineCompatibility, known: boolean): typeof fetch {
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const operation = operations.find((op) => op.method === method && op.route.test(url.pathname));
    if (url.origin !== base.origin || !operation ||
      (method !== "GET" && !known) ||
      (operation.id === "session.prompt" && !compatibility.canSend) ||
      (operation.id === "event.subscribe" && !compatibility.checks.some((check) => check.feature === "stream" && check.state === "verified"))) {
      return Promise.reject(new Error("Операция недоступна для этой версии OpenCode."));
    }
    return fetch(input, { ...init, redirect: "error" });
  };
}
