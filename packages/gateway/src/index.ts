#!/usr/bin/env node
import { createServer } from "node:http";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { loadEnv, parseListen } from "@larkinfra/shared";
import { loadConfig } from "./config.js";
import { openTraceStore } from "./db.js";
import { mountAdminRoutes } from "./http/admin.js";
import { mountHttpRoutes, TicketStore } from "./http/routes.js";
import { mountWebUi } from "./http/web.js";
import { AppRegistry } from "./ws/app-registry.js";
import { InstanceRegistry } from "./ws/registry.js";
import { attachDownstreamWs } from "./ws/downstream.js";
import { UpstreamManager } from "./ws/upstream.js";

async function main() {
  const envPath = loadEnv();
  if (envPath) console.info(`[env] loaded ${envPath}`);

  const config = loadConfig(process.argv[2]);
  const { host, port } = parseListen(config.listen);
  const store = await openTraceStore(config.duckdb.path);
  const registry = new InstanceRegistry();
  const tickets = new TicketStore();
  const apps = new AppRegistry(config.apps, config.appDefaults);

  if (config.apps.length > 0) {
    console.info(
      `[apps] seeded ${config.apps.length} app(s) from config/env (optional bootstrap)`,
    );
  }

  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: true }));

  const webDist = mountWebUi(app);
  if (webDist) console.info(`[web] serving UI from ${webDist}`);
  else console.warn("[web] UI dist missing — run pnpm --filter @larkinfra/web build");

  // Assigned after Downstream + Upstream are constructed; endpoint requests
  // cannot arrive before the HTTP server is listening.
  let upstream!: UpstreamManager;

  mountHttpRoutes({
    app,
    config,
    store,
    tickets,
    apps,
    onAppReady: (appId) => upstream.ensureApp(appId),
  });

  const server = serve(
    {
      fetch: app.fetch,
      createServer,
      hostname: host,
      port,
    },
    (info) => {
      console.info(
        `[gateway] listening on http://${info.address}:${info.port}`,
      );
    },
  );

  const httpServer = server as unknown as import("node:http").Server;

  const downstream = attachDownstreamWs({
    server: httpServer,
    registry,
    config,
    apps,
    resolveAppId: (req) => {
      try {
        const u = new URL(req.url ?? "", "http://localhost");
        const deviceId = u.searchParams.get("device_id");
        const ticket = tickets.peek(deviceId);
        if (ticket) return ticket.appId;
        return u.searchParams.get("app_id") ?? undefined;
      } catch {
        return undefined;
      }
    },
  });

  upstream = new UpstreamManager(config, apps, registry, downstream, store);
  mountAdminRoutes({ app, config, store, registry, downstream, apps });

  await upstream.start();
  if (apps.list().length === 0) {
    console.info(
      "[gateway] no apps yet — waiting for agents to register via /callback/ws/endpoint",
    );
  }

  const shutdown = async () => {
    console.info("[gateway] shutting down");
    await upstream.stop();
    await downstream.close();
    await store.close();
    httpServer.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
