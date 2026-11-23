import { OpenCodeSupervisor } from "../electron/supervisor";
import { Redactor } from "../electron/security";
import path from "node:path";
const engine = new OpenCodeSupervisor(
  path.resolve(".runtime/probe"),
  path.resolve("node_modules/@opencode/cli/bin/opencode.exe"),
  new Redactor(),
  (status) => console.log(status),
);
try {
  const client = await engine.ensure();
  console.log("Info", (await client.server.info()).version);
  const [models, integrations] = await Promise.all([
    client.model.list(),
    client.integration.list(),
  ]);
  console.log(
    "Models",
    models.data.length,
    models.data
      .filter((m) => m.enabled)
      .slice(0, 6)
      .map((m) => ({ id: m.id, provider: m.providerID })),
  );
  console.log(
    "Integrations",
    integrations.data.length,
    integrations.data
      .slice(0, 5)
      .map((i) => ({ id: i.id, methods: i.methods.map((m) => m.type) })),
  );
  const session = await client.session.create({
    location: { directory: path.resolve(".runtime/probe-project") },
    permissions: [{ action: "*", resource: "*", effect: "ask" }],
  });
  console.log("Session", session.id, session.location);
  console.log(
    "Project integrations",
    (await client.integration.list({ location: session.location })).data
      .map((i) => ({ id: i.id, methods: i.methods.map((m) => m.type) }))
      .slice(0, 12),
  );
  console.log(
    "Plugin metadata",
    JSON.stringify(
      (await client.plugin.list({ location: session.location })).data.map(
        (p) => ({
          id: p.id,
          ...("error" in p ? { error: p.error } : {}),
          ...("disabled" in p ? { disabled: p.disabled } : {}),
        }),
      ),
    ).slice(0, 4000),
  );
  console.log(
    "Providers",
    (await client.provider.list({ location: session.location })).data
      .map((p) => ({
        id: p.id,
        package: p.package,
        integration: p.integrationID,
      }))
      .slice(0, 8),
  );
  console.log(
    "Messages",
    (
      await client.message.list({
        sessionID: session.id,
        limit: 20,
        order: "desc",
      })
    ).data.map((m) => m.type),
  );
} finally {
  await engine.stop();
}
