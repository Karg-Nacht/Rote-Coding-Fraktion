import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { omniRouteBaseUrl } from "../shared/provider-url";
import {
  providerModels,
  parseProviderModels,
} from "../electron/provider-catalog";
import { diffLines } from "../shared/diff";
import { highlightDiff } from "../src/highlight";

test("OmniRoute URL uses a /v1 root and never accepts credentials or token aliases", () => {
  assert.equal(
    omniRouteBaseUrl(" http://localhost:20128/v1/ "),
    "http://localhost:20128/v1",
  );
  assert.equal(
    omniRouteBaseUrl("https://gateway.example/proxy/v1"),
    "https://gateway.example/proxy/v1",
  );
  for (const url of [
    "file:///v1",
    "https://u:p@gateway.example/v1",
    "https://gateway.example/v1?api_key=secret",
    "https://gateway.example/v1/chat/completions",
    "https://gateway.example/api/v1/vscode/secret/",
  ])
    assert.throws(() => omniRouteBaseUrl(url));
});

test("OmniRoute catalog preserves exact model/combo IDs and exposes only model names", () => {
  const result = parseProviderModels({
    data: [
      {
        id: "provider/model:exact",
        name: "Model",
        credential: "never expose this",
      },
      { id: "my-coding-combo" },
      { id: "provider/model:exact", name: "Latest" },
      { id: "bad\nmodel" },
      { id: 3 },
    ],
  });
  assert.deepEqual(result, [
    { id: "my-coding-combo", name: "my-coding-combo" },
    { id: "provider/model:exact", name: "Latest" },
  ]);
  assert.deepEqual(parseProviderModels({ data: [] }), []);
  assert.throws(() => parseProviderModels({ models: [] }));
});

test("catalog HTTP uses Bearer auth, no redirect, sanitized status errors and bounded response", async () => {
  let sawKey = false,
    followedRedirect = false;
  const server = http.createServer((request, response) => {
    if (request.url === "/v1/models") {
      sawKey =
        request.headers.authorization === "Bearer qa-catalog-fixture-key";
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "combo-exact" }] }));
    } else if (request.url === "/denied/v1/models")
      response.writeHead(401).end("DO_NOT_ECHO_ERROR_BODY");
    else if (request.url === "/unavailable/v1/models")
      response
        .writeHead(503, { "content-type": "application/json" })
        .end(
          JSON.stringify({
            error: {
              code: "SERVICE_UNAVAILABLE",
              message: "DO_NOT_ECHO_ERROR_BODY",
              correlation_id: "qa-request-503",
            },
          }),
        );
    else if (request.url === "/redirect/v1/models")
      response.writeHead(302, { Location: "/target/v1/models" }).end();
    else if (request.url === "/target/v1/models") {
      followedRedirect = true;
      response.end("{}");
    } else if (request.url === "/large/v1/models")
      response.end(" ".repeat(8 * 1024 * 1024 + 1));
    else response.end("<html>DO_NOT_ECHO_ERROR_BODY</html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    assert.deepEqual(
      await providerModels({
        baseUrl: `${url}/v1`,
        key: "qa-catalog-fixture-key",
      }),
      [{ id: "combo-exact", name: "combo-exact" }],
    );
    assert.equal(sawKey, true);
    await assert.rejects(
      providerModels({ baseUrl: `${url}/denied/v1` }),
      (error) =>
        error instanceof Error &&
        error.message.includes("API ключ") &&
        !error.message.includes("DO_NOT_ECHO"),
    );
    await assert.rejects(providerModels({ baseUrl: `${url}/redirect/v1` }));
    assert.equal(followedRedirect, false);
    await assert.rejects(
      providerModels({ baseUrl: `${url}/unavailable/v1` }),
      (error) =>
        error instanceof Error &&
        error.message.includes("HTTP 503") &&
        error.message.includes("SERVICE_UNAVAILABLE") &&
        error.message.includes("qa-request-503") &&
        !error.message.includes("Проверьте Base URL") &&
        !error.message.includes("DO_NOT_ECHO"),
    );
    await assert.rejects(
      providerModels({ baseUrl: `${url}/html/v1` }),
      /не JSON/,
    );
    await assert.rejects(
      providerModels({ baseUrl: `${url}/large/v1` }),
      /8 МБ/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("unified diff gutters count old/new lines across hunks, excluding file headers", () => {
  const result = diffLines(
    "--- a/a.ts\n+++ b/a.ts\n@@ -8,2 +8,3 @@\n unchanged\n-old\n+new\n+++ literal pluses\n@@ -20 +21 @@\n-before\n+after\n\\ No newline at end of file\n",
  );
  assert.deepEqual(result.slice(0, 3), [
    { kind: "header" },
    { kind: "header" },
    { kind: "hunk" },
  ]);
  assert.deepEqual(result.slice(3, 7), [
    { kind: "context", old: 8, next: 8 },
    { kind: "delete", old: 9 },
    { kind: "add", next: 9 },
    { kind: "add", next: 10 },
  ]);
  assert.deepEqual(result.slice(8, 11), [
    { kind: "delete", old: 20 },
    { kind: "add", next: 21 },
    { kind: "header" },
  ]);
});
test("compact highlighted diff retains actual code and gutters while full view retains patch metadata", async () => {
  const patch =
    "diff --git a/result.txt b/result.txt\n--- /dev/null\n+++ b/result.txt\n@@ -0,0 +1 @@\n+HELLO FORGE\n";
  const compact = await highlightDiff(patch, true);
  assert.ok(compact.includes("HELLO FORGE"));
  assert.ok(compact.includes('data-new="1"'));
  assert.equal(compact.includes("diff --git"), false);
  assert.equal(compact.includes("diff-hunk"), false);
  const full = await highlightDiff(patch);
  assert.ok(full.includes("diff --git"));
  assert.ok(full.includes("HELLO FORGE"));
});
