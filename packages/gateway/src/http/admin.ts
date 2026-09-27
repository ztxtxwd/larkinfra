import type { Hono } from "hono";
import { randomUUID } from "node:crypto";
import {
  buildSignalEventPayload,
  extractEventType,
  extractUserId,
  isAgentSignal,
  tryParseAppEnv,
  tryParseUserTag,
  pickInstanceId,
  routingKey,
  truncate,
  type GatewayConfig,
} from "@larkinfra/shared";
import type { TraceStore } from "../db.js";
import type { InstanceRegistry } from "../ws/registry.js";
import type { DownstreamServer } from "../ws/downstream.js";
import type { AppRegistry } from "../ws/app-registry.js";

export function mountAdminRoutes(params: {
  app: Hono;
  config: GatewayConfig;
  store: TraceStore;
  registry: InstanceRegistry;
  downstream: DownstreamServer;
  apps: AppRegistry;
}): void {
  const { app, config, store, registry, downstream, apps } = params;

  app.use("/admin/*", async (c, next) => {
    const token =
      c.req.header("x-admin-token") ??
      c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (token !== config.admin.token) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.get("/admin/health", (c) =>
    c.json({
      ok: true,
      apps: apps.listIds(),
      instances: registry.listAll().map((i) => ({
        appId: i.appId,
        instanceId: i.instanceId,
        env: i.env,
        connectedAt: i.connectedAt,
        lastHeartbeatAt: i.lastHeartbeatAt,
        draining: i.draining,
      })),
    }),
  );

  app.get("/admin/apps/:appId/instances", (c) => {
    const appId = c.req.param("appId");
    return c.json({
      appId,
      instances: registry.list(appId).map((i) => ({
        instanceId: i.instanceId,
        env: i.env,
        connectedAt: i.connectedAt,
        lastHeartbeatAt: i.lastHeartbeatAt,
        serviceId: i.serviceId,
        draining: i.draining,
      })),
    });
  });

  /**
   * Update a live instance's Feishu app environment.
   * body: { env: "dev" | "test" | "staging" | "prod" }
   */
  app.patch("/admin/instances/:instanceId", async (c) => {
    const instanceId = c.req.param("instanceId");
    const body = (await c.req.json().catch(() => ({}))) as { env?: string };
    const env = tryParseAppEnv(body.env);
    if (!env) {
      return c.json(
        { error: 'env must be "dev" | "test" | "staging" | "prod"' },
        400,
      );
    }

    const instance = registry.findByInstanceId(instanceId);
    if (!instance) {
      return c.json({ error: "instance not found" }, 404);
    }
    registry.setEnv(instance.appId, instance.instanceId, env);
    return c.json({
      ok: true,
      appId: instance.appId,
      instanceId: instance.instanceId,
      env: instance.env,
    });
  });

  /**
   * Push a lifecycle signal to one agent over the downstream WS event channel.
   * Marks the instance draining first so routing skips it (zero-loss rollouts).
   *
   * body: { signal: "graceful" | "force", reason?: string, waitOfflineMs?: number }
   */
  app.post("/admin/apps/:appId/instances/:instanceId/signal", async (c) => {
    const appId = c.req.param("appId");
    const instanceId = c.req.param("instanceId");
    const body = (await c.req.json().catch(() => ({}))) as {
      signal?: string;
      reason?: string;
      waitOfflineMs?: number;
    };

    if (!body.signal || !isAgentSignal(body.signal)) {
      return c.json(
        { error: 'signal must be "graceful" or "force"' },
        400,
      );
    }

    const instance = registry.get(appId, instanceId);
    if (!instance) {
      return c.json({ error: "instance not found" }, 404);
    }
    if (instance.socket.readyState !== instance.socket.OPEN) {
      return c.json({ error: "instance socket not open" }, 409);
    }

    // Stop routing new events before the agent even sees the signal.
    registry.markDraining(appId, instanceId);

    const messageId = randomUUID();
    const traceId = randomUUID();
    const payload = buildSignalEventPayload({
      signal: body.signal,
      appId,
      instanceId,
      reason: body.reason,
    });

    try {
      // Prefer ACK so we know the handler ran; fall back is still draining.
      await downstream.sendEventAndWaitAck({
        appId,
        instanceId,
        messageId,
        traceId,
        payload,
        timeoutMs: Math.min(config.routing.ackTimeoutMs, 5_000),
      });
    } catch (err) {
      // Agent may have closed mid-ACK on force; still proceed.
      console.warn(
        `[admin] signal ack app=${appId} instance=${instanceId} signal=${body.signal}:`,
        err instanceof Error ? err.message : err,
      );
    }

    if (body.signal === "force") {
      // Hard cut if the agent ignores force — drop the WS so it leaves the pool.
      try {
        instance.socket.terminate();
      } catch {
        // ignore
      }
      registry.unregister(instance.socket);
      return c.json({
        ok: true,
        signal: body.signal,
        instanceId,
        status: "terminated",
      });
    }

    const waitMs = Number(body.waitOfflineMs ?? 0);
    if (waitMs > 0) {
      const outcome = await registry.waitUntilOffline(
        appId,
        instanceId,
        waitMs,
      );
      return c.json({
        ok: true,
        signal: body.signal,
        instanceId,
        status: outcome,
      });
    }

    return c.json({
      ok: true,
      signal: body.signal,
      instanceId,
      status: "signaled",
      draining: true,
    });
  });

  app.get("/admin/traces/events", async (c) => {
    const userId = c.req.query("user_id") ?? undefined;
    const eventType = c.req.query("event_type") ?? undefined;
    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const rows = await store.queryEvents({
      userId,
      eventType,
      limit: Math.min(limit, 200),
      offset,
    });
    return c.json({ rows });
  });

  app.get("/admin/traces/http", async (c) => {
    const pathQ = c.req.query("path") ?? undefined;
    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const rows = await store.queryHttp({
      path: pathQ,
      limit: Math.min(limit, 200),
      offset,
    });
    return c.json({ rows });
  });

  app.get("/admin/users/remarks", async (c) => {
    const rows = await store.listUserRemarks();
    return c.json({ rows });
  });

  app.put("/admin/users/:userId/remark", async (c) => {
    const userId = decodeURIComponent(c.req.param("userId")).trim();
    if (!userId) {
      return c.json({ error: "userId required" }, 400);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      remark?: unknown;
    };
    if (typeof body.remark !== "string") {
      return c.json({ error: "remark must be a string" }, 400);
    }
    const remark = body.remark.trim();
    if (!remark) {
      return c.json({ error: "remark must not be empty" }, 400);
    }
    if (remark.length > 64) {
      return c.json({ error: "remark max length is 64" }, 400);
    }
    const row = await store.upsertUserRemark(userId, remark);
    return c.json({ ok: true, row });
  });

  app.delete("/admin/users/:userId/remark", async (c) => {
    const userId = decodeURIComponent(c.req.param("userId")).trim();
    if (!userId) {
      return c.json({ error: "userId required" }, 400);
    }
    const deleted = await store.deleteUserRemark(userId);
    if (!deleted) {
      return c.json({ error: "remark not found" }, 404);
    }
    return c.json({ ok: true, userId });
  });

  app.get("/admin/users/tags", async (c) => {
    const rows = await store.listUserTags();
    return c.json({ rows });
  });

  app.put("/admin/users/:userId/tag", async (c) => {
    const userId = decodeURIComponent(c.req.param("userId")).trim();
    if (!userId) {
      return c.json({ error: "userId required" }, 400);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      tag?: unknown;
    };
    if (typeof body.tag !== "string") {
      return c.json({ error: "tag must be a string" }, 400);
    }
    const tag = tryParseUserTag(body.tag);
    if (!tag) {
      return c.json(
        { error: 'tag must be "developer" | "tester" | "user"' },
        400,
      );
    }
    const row = await store.upsertUserTag(userId, tag);
    return c.json({ ok: true, row });
  });

  app.delete("/admin/users/:userId/tag", async (c) => {
    const userId = decodeURIComponent(c.req.param("userId")).trim();
    if (!userId) {
      return c.json({ error: "userId required" }, 400);
    }
    const deleted = await store.deleteUserTag(userId);
    if (!deleted) {
      return c.json({ error: "tag not found" }, 404);
    }
    return c.json({ ok: true, userId });
  });

  /** 本地注入事件，验证分流/ACK（不经飞书上游）。 */
  app.post("/admin/inject-event", async (c) => {
    const body = (await c.req.json()) as {
      appId?: string;
      payload?: unknown;
    };
    const appId = body.appId ?? apps.listIds()[0];
    if (!appId || !body.payload) {
      return c.json({ error: "appId and payload required" }, 400);
    }
    const payload = body.payload;
    const traceId = randomUUID();
    const messageId = randomUUID();
    const userId = extractUserId(payload);
    const eventType = extractEventType(payload);
    const key = routingKey(payload);

    await store.insertEvent({
      traceId,
      appId,
      eventType,
      userId,
      status: "pending",
      payload: truncate(JSON.stringify(payload), config.duckdb.bodyMaxChars),
    });

    const tagRow = userId ? await store.getUserTag(userId) : null;
    const { instanceIds, env: preferredEnv } = registry.listRoutableIdsForTag(
      appId,
      tagRow?.tag,
    );
    const instanceId = pickInstanceId(key, instanceIds);
    if (!instanceId) {
      const error = "no online instances matching user tag preference";
      await store.updateEvent(traceId, {
        status: "dropped",
        error,
      });
      return c.json({ ok: false, traceId, error }, 503);
    }

    try {
      await store.updateEvent(traceId, {
        instanceId,
        status: "routed",
        routedAt: true,
      });
      const ack = await downstream.sendEventAndWaitAck({
        appId,
        instanceId,
        messageId,
        traceId,
        payload,
        timeoutMs: config.routing.ackTimeoutMs,
      });
      await store.updateEvent(traceId, { status: "acked", ackedAt: true });
      return c.json({
        ok: true,
        traceId,
        instanceId,
        userId,
        preferredEnv,
        tag: tagRow?.tag ?? "user",
        ack,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await store.updateEvent(traceId, { status: "failed", error: message });
      return c.json({ ok: false, traceId, instanceId, error: message }, 500);
    }
  });
}
