import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  FrameType,
  HeaderKey,
  MessageType,
  buildPingFrame,
  decodeFrame,
  encodeFrame,
  extractEventType,
  extractUserId,
  getHeader,
  pickInstanceId,
  routingKey,
  truncate,
  type GatewayConfig,
  type AppConfig,
} from "@larkinfra/shared";
import type { TraceStore } from "../db.js";
import type { InstanceRegistry } from "./registry.js";
import type { DownstreamServer } from "./downstream.js";
import { FrameDataCache, payloadFromFrame } from "./frame-cache.js";
import type { AppRegistry } from "./app-registry.js";

interface UpstreamConn {
  app: AppConfig;
  ws: WebSocket | null;
  serviceId: number;
  deviceId: string;
  pingTimer?: NodeJS.Timeout;
  stopped: boolean;
  dataCache: FrameDataCache;
}

export class UpstreamManager {
  private conns: UpstreamConn[] = [];
  /** appIds that already have connect loops started. */
  private startedApps = new Set<string>();

  constructor(
    private config: GatewayConfig,
    private apps: AppRegistry,
    private registry: InstanceRegistry,
    private downstream: DownstreamServer,
    private store: TraceStore,
  ) {}

  /** Start upstream for every currently registered app (bootstrap seed). */
  async start(): Promise<void> {
    for (const app of this.apps.list()) {
      this.ensureApp(app.appId);
    }
  }

  /**
   * Ensure upstream WS loops are running for `appId`.
   * Idempotent — safe to call on every agent connect / register.
   */
  ensureApp(appId: string): void {
    if (this.startedApps.has(appId)) return;
    const app = this.apps.get(appId);
    if (!app) {
      console.warn(`[upstream] ensureApp unknown app=${appId}`);
      return;
    }
    const count = app.upstreamConnections ?? 1;
    if (count <= 0) {
      console.info(
        `[upstream] app=${appId} upstreamConnections=0 — skip Feishu WS`,
      );
      this.startedApps.add(appId);
      return;
    }
    this.startedApps.add(appId);
    for (let i = 0; i < count; i++) {
      const conn: UpstreamConn = {
        app,
        ws: null,
        serviceId: this.config.ws.serviceId,
        deviceId: randomUUID(),
        stopped: false,
        dataCache: new FrameDataCache(),
      };
      this.conns.push(conn);
      void this.connectLoop(conn);
    }
    console.info(
      `[upstream] started app=${appId} connections=${count}`,
    );
  }

  async stop(): Promise<void> {
    for (const conn of this.conns) {
      conn.stopped = true;
      if (conn.pingTimer) clearTimeout(conn.pingTimer);
      conn.ws?.terminate();
    }
  }

  private async connectLoop(conn: UpstreamConn): Promise<void> {
    while (!conn.stopped) {
      try {
        await this.connectOnce(conn);
      } catch (err) {
        console.error(
          `[upstream] app=${conn.app.appId} connect error`,
          err instanceof Error ? err.message : err,
        );
      }
      if (conn.stopped) return;
      await sleep(3_000 + Math.random() * 2_000);
    }
  }

  private async connectOnce(conn: UpstreamConn): Promise<void> {
    // Refresh credentials from registry in case of re-register (same secret).
    const latest = this.apps.get(conn.app.appId);
    if (latest) conn.app = latest;

    const endpoint = await this.pullEndpoint(conn.app);
    conn.serviceId = endpoint.serviceId;
    console.info(
      `[upstream] connecting app=${conn.app.appId} url=${endpoint.url}`,
    );

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(endpoint.url);
      conn.ws = ws;

      ws.on("open", () => {
        console.info(`[upstream] connected app=${conn.app.appId}`);
        this.schedulePing(conn);
      });

      ws.on("message", (data) => {
        void this.onMessage(conn, data);
      });

      ws.on("error", (err) => {
        console.error(`[upstream] error app=${conn.app.appId}`, err.message);
      });

      ws.on("close", () => {
        if (conn.pingTimer) clearTimeout(conn.pingTimer);
        conn.ws = null;
        console.warn(`[upstream] closed app=${conn.app.appId}`);
        resolve();
      });

      setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CLOSED) {
          ws.terminate();
          reject(new Error("upstream connect timeout"));
        }
      }, 15_000).unref?.();
    });
  }

  private async pullEndpoint(app: AppConfig): Promise<{
    url: string;
    serviceId: number;
    deviceId: string;
  }> {
    const res = await fetch(
      `${this.config.upstream.domain}/callback/ws/endpoint`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          locale: "zh",
        },
        body: JSON.stringify({
          AppID: app.appId,
          AppSecret: app.appSecret,
        }),
      },
    );
    if (!res.ok) {
      throw new Error(`endpoint http ${res.status}`);
    }
    const body = (await res.json()) as {
      code: number;
      msg?: string;
      data?: {
        URL?: string;
        ClientConfig?: Record<string, number>;
      };
    };
    if (body.code !== 0 || !body.data?.URL) {
      throw new Error(`endpoint code=${body.code} msg=${body.msg}`);
    }
    const url = new URL(body.data.URL);
    const serviceId = Number(url.searchParams.get("service_id") ?? this.config.ws.serviceId);
    const deviceId = String(url.searchParams.get("device_id") ?? randomUUID());
    return { url: body.data.URL, serviceId, deviceId };
  }

  private schedulePing(conn: UpstreamConn): void {
    if (conn.pingTimer) clearTimeout(conn.pingTimer);
    const tick = () => {
      if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) return;
      try {
        conn.ws.send(encodeFrame(buildPingFrame(conn.serviceId)));
      } catch (err) {
        console.error("[upstream] ping failed", err);
      }
      conn.pingTimer = setTimeout(tick, this.config.ws.pingIntervalSec * 1000);
    };
    conn.pingTimer = setTimeout(tick, this.config.ws.pingIntervalSec * 1000);
  }

  private async onMessage(
    conn: UpstreamConn,
    data: WebSocket.RawData,
  ): Promise<void> {
    try {
      const buf = Buffer.isBuffer(data)
        ? data
        : Buffer.from(data as ArrayBuffer);
      const frame = decodeFrame(new Uint8Array(buf));
      const type = getHeader(frame.headers, HeaderKey.type);

      if (frame.method === FrameType.control) {
        return;
      }

      if (frame.method !== FrameType.data || type !== MessageType.event) {
        return;
      }

      conn.dataCache.sweep();
      const merged = payloadFromFrame(conn.dataCache, frame);
      if (merged == null) return;
      await this.routeEvent(conn, frame, merged);
    } catch (err) {
      console.error("[upstream] onMessage error", err);
    }
  }

  private async routeEvent(
    conn: UpstreamConn,
    frame: ReturnType<typeof decodeFrame>,
    merged: unknown,
  ): Promise<void> {
    const traceId =
      getHeader(frame.headers, HeaderKey.trace_id) ?? randomUUID();
    const messageId =
      getHeader(frame.headers, HeaderKey.message_id) ?? randomUUID();
    const userId = extractUserId(merged);
    const eventType = extractEventType(merged);
    const key = routingKey(merged);

    await this.store.insertEvent({
      traceId,
      appId: conn.app.appId,
      eventType,
      userId,
      status: "pending",
      payload: truncate(
        JSON.stringify(merged),
        this.config.duckdb.bodyMaxChars,
      ),
    });

    const tagRow = userId ? await this.store.getUserTag(userId) : null;
    const { instanceIds } = this.registry.listRoutableIdsForTag(
      conn.app.appId,
      tagRow?.tag,
    );
    const instanceId = pickInstanceId(key, instanceIds);

    const start = Date.now();
    let respPayload: { code: number; data?: string } = { code: 200 };

    if (!instanceId) {
      await this.store.updateEvent(traceId, {
        status: "dropped",
        error: "no online instances matching user tag preference",
      });
      respPayload = { code: 500 };
      await this.replyUpstream(conn, frame, respPayload, start);
      return;
    }

    try {
      await this.store.updateEvent(traceId, {
        instanceId,
        status: "routed",
        routedAt: true,
      });
      const ack = await this.downstream.sendEventAndWaitAck({
        appId: conn.app.appId,
        instanceId,
        messageId,
        traceId,
        payload: merged,
        timeoutMs: this.config.routing.ackTimeoutMs,
      });
      if (ack && typeof ack === "object" && "code" in (ack as object)) {
        const code = Number((ack as { code: number }).code);
        respPayload = {
          code: Number.isFinite(code) ? code : 200,
        };
        const data = (ack as { data?: string }).data;
        if (data) respPayload.data = data;
      }
      await this.store.updateEvent(traceId, {
        status: "acked",
        ackedAt: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.store.updateEvent(traceId, {
        status: "failed",
        error: message,
      });
      respPayload = { code: 500 };
    }

    await this.replyUpstream(conn, frame, respPayload, start);
  }

  private async replyUpstream(
    conn: UpstreamConn,
    frame: ReturnType<typeof decodeFrame>,
    respPayload: { code: number; data?: string },
    start: number,
  ): Promise<void> {
    if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) return;
    const end = Date.now();
    const reply = {
      ...frame,
      headers: [
        ...frame.headers,
        { key: HeaderKey.biz_rt, value: String(start - end) },
      ],
      payload: new TextEncoder().encode(JSON.stringify(respPayload)),
    };
    conn.ws.send(encodeFrame(reply));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
