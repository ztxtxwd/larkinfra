import { randomUUID } from "node:crypto";
import type { GatewayConfig } from "@larkinfra/shared";
import { truncate, sha256Short } from "@larkinfra/shared";
import type { Context, Hono } from "hono";
import type { TraceStore } from "../db.js";
import type { AppRegistry } from "../ws/app-registry.js";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

/** fetch 读 body 后会自动解压，这些头不能再原样回给客户端。 */
const RESPONSE_STRIP = new Set([
  ...HOP_BY_HOP,
  "content-encoding",
  "content-length",
]);

export interface EndpointTicket {
  appId: string;
  deviceId: string;
  serviceId: number;
  expiresAt: number;
}

export class TicketStore {
  private tickets = new Map<string, EndpointTicket>();

  issue(appId: string, serviceId: number): EndpointTicket {
    const deviceId = randomUUID();
    const ticket: EndpointTicket = {
      appId,
      deviceId,
      serviceId,
      expiresAt: Date.now() + 5 * 60_000,
    };
    this.tickets.set(deviceId, ticket);
    return ticket;
  }

  resolve(deviceId: string | null | undefined): EndpointTicket | undefined {
    if (!deviceId) return undefined;
    const ticket = this.tickets.get(deviceId);
    if (!ticket) return undefined;
    if (ticket.expiresAt < Date.now()) {
      this.tickets.delete(deviceId);
      return undefined;
    }
    return ticket;
  }

  /** Keep ticket around for reconnects until TTL. */
  peek(deviceId: string | null | undefined): EndpointTicket | undefined {
    return this.resolve(deviceId);
  }
}

function publicBase(c: Context, config: GatewayConfig): {
  httpBase: string;
  wsBase: string;
} {
  if (config.publicHost) {
    const httpBase = config.publicHost.replace(/\/$/, "");
    const wsBase = httpBase.replace(/^http/, "ws");
    return { httpBase, wsBase };
  }
  const host = c.req.header("host") ?? "127.0.0.1:18787";
  const proto = c.req.header("x-forwarded-proto") ?? "http";
  const httpBase = `${proto}://${host}`;
  const wsBase = `${proto === "https" ? "wss" : "ws"}://${host}`;
  return { httpBase, wsBase };
}

function guessAppId(
  apps: AppRegistry,
  authHeader: string | undefined,
  bodyText: string,
): string | undefined {
  const ids = apps.listIds();
  if (ids.length === 1) return ids[0];
  try {
    const json = JSON.parse(bodyText) as Record<string, unknown>;
    if (typeof json.app_id === "string") return json.app_id;
    if (typeof json.AppID === "string") return json.AppID;
  } catch {
    // ignore
  }
  if (authHeader?.startsWith("Bearer ")) {
    // cannot map token to app without cache; leave undefined
  }
  return undefined;
}

export function mountHttpRoutes(params: {
  app: Hono;
  config: GatewayConfig;
  store: TraceStore;
  tickets: TicketStore;
  apps: AppRegistry;
  /** Called after an app is registered/authenticated so upstream WS can start. */
  onAppReady: (appId: string) => void;
}): void {
  const { app, config, store, tickets, apps, onAppReady } = params;

  /**
   * Agent (official WSClient) handshake: present AppID/AppSecret.
   * Unknown apps are auto-registered; known apps must match secret.
   * On (new) registration, gateway starts upstream Feishu WS for that app.
   */
  app.post("/callback/ws/endpoint", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      AppID?: string;
      AppSecret?: string;
    } | null;
    const appId = body?.AppID;
    const appSecret = body?.AppSecret;
    if (!appId || !appSecret) {
      return c.json({ code: 514, msg: "AppID/AppSecret required" }, 200);
    }

    const result = apps.registerOrAuth({ appId, appSecret });
    if (!result.ok) {
      return c.json({ code: 514, msg: result.error }, 200);
    }

    // Pull Feishu upstream as soon as an agent registers / reconnects.
    onAppReady(appId);

    const ticket = tickets.issue(appId, config.ws.serviceId);
    const { wsBase } = publicBase(c, config);
    const url = `${wsBase}/ws/v2?device_id=${encodeURIComponent(ticket.deviceId)}&service_id=${ticket.serviceId}&app_id=${encodeURIComponent(appId)}&env=${encodeURIComponent(result.app.env)}`;

    return c.json({
      code: 0,
      msg: "ok",
      data: {
        URL: url,
        ClientConfig: {
          PingInterval: config.ws.pingIntervalSec,
          ReconnectCount: config.ws.reconnectCount,
          ReconnectInterval: config.ws.reconnectIntervalSec,
          ReconnectNonce: config.ws.reconnectNonceSec,
        },
      },
    });
  });

  app.all("/open-apis/*", async (c) => {
    const started = Date.now();
    const url = new URL(c.req.url);
    const pathWithQuery = `${url.pathname}${url.search}`;
    const target = `${config.upstream.domain}${pathWithQuery}`;
    const method = c.req.method;
    const reqHeaders = new Headers();
    c.req.raw.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (!HOP_BY_HOP.has(lower) && lower !== "accept-encoding") {
        reqHeaders.set(key, value);
      }
    });
    // 让上游返回未压缩正文，避免与 Node fetch 自动解压冲突
    reqHeaders.set("accept-encoding", "identity");

    const rawBody =
      method === "GET" || method === "HEAD"
        ? undefined
        : Buffer.from(await c.req.arrayBuffer());

    const bodyText = rawBody ? rawBody.toString("utf8") : "";
    const appId = guessAppId(
      apps,
      c.req.header("authorization"),
      bodyText,
    );

    let upstreamResp: Response;
    try {
      upstreamResp = await fetch(target, {
        method,
        headers: reqHeaders,
        body: rawBody,
        redirect: "manual",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await store.insertHttpRequest({
        traceId: randomUUID(),
        appId,
        method,
        path: pathWithQuery,
        statusCode: 502,
        durationMs: Date.now() - started,
        requestSnippet: config.duckdb.storeBodies
          ? truncate(bodyText, config.duckdb.bodyMaxChars)
          : sha256Short(bodyText),
        responseSnippet: message,
      });
      return c.json({ code: 502, msg: message }, 502);
    }

    const respBuf = Buffer.from(await upstreamResp.arrayBuffer());
    const respText = respBuf.toString("utf8");
    const outHeaders = new Headers();
    upstreamResp.headers.forEach((value, key) => {
      if (!RESPONSE_STRIP.has(key.toLowerCase())) {
        outHeaders.set(key, value);
      }
    });
    outHeaders.set("content-length", String(respBuf.byteLength));

    await store.insertHttpRequest({
      traceId: randomUUID(),
      appId,
      method,
      path: pathWithQuery,
      statusCode: upstreamResp.status,
      durationMs: Date.now() - started,
      requestSnippet: config.duckdb.storeBodies
        ? truncate(bodyText, config.duckdb.bodyMaxChars)
        : sha256Short(bodyText || "-"),
      responseSnippet: config.duckdb.storeBodies
        ? truncate(respText, config.duckdb.bodyMaxChars)
        : sha256Short(respText || "-"),
    });

    return new Response(respBuf, {
      status: upstreamResp.status,
      statusText: upstreamResp.statusText,
      headers: outHeaders,
    });
  });
}
