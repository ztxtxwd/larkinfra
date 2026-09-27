import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  FrameType,
  HeaderKey,
  MessageType,
  buildEventFrame,
  buildPongFrame,
  decodeFrame,
  encodeFrame,
  getHeader,
  resolveAppEnv,
  type GatewayConfig,
} from "@larkinfra/shared";
import type { InstanceRegistry } from "./registry.js";
import type { AppRegistry } from "./app-registry.js";

export interface DownstreamServer {
  wss: WebSocketServer;
  pendingAcks: Map<
    string,
    {
      resolve: (payload: unknown) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  >;
  sendEventAndWaitAck(params: {
    appId: string;
    instanceId: string;
    messageId: string;
    traceId: string;
    payload: unknown;
    timeoutMs: number;
  }): Promise<unknown>;
  /** Fire-and-forget event frame (no ACK wait). */
  sendEvent(params: {
    appId: string;
    instanceId: string;
    messageId: string;
    traceId: string;
    payload: unknown;
  }): void;
  close(): Promise<void>;
}

function parseAppIdFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url, "http://localhost");
    return (
      u.searchParams.get("app_id") ??
      u.searchParams.get("AppID") ??
      u.searchParams.get("device_id")?.split(".")[0] ??
      undefined
    );
  } catch {
    return undefined;
  }
}

function parseEnvFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url, "http://localhost");
    return u.searchParams.get("env") ?? undefined;
  } catch {
    return undefined;
  }
}

export function attachDownstreamWs(params: {
  server: HttpServer;
  registry: InstanceRegistry;
  config: GatewayConfig;
  apps: AppRegistry;
  resolveAppId: (req: IncomingMessage) => string | undefined;
}): DownstreamServer {
  const { server, registry, config, apps } = params;
  const pendingAcks = new Map<
    string,
    {
      resolve: (payload: unknown) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "";
    if (!url.startsWith("/ws/")) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const appId =
      params.resolveAppId(req) ??
      parseAppIdFromUrl(req.url) ??
      undefined;

    if (!appId) {
      console.warn("[downstream] reject connection without appId");
      ws.close(1008, "appId required");
      return;
    }

    const known = apps.get(appId);
    if (!known) {
      console.warn(`[downstream] unknown appId=${appId}`);
      ws.close(1008, "unknown app");
      return;
    }

    const instanceId = randomUUID();
    const serviceId = config.ws.serviceId;
    const env = resolveAppEnv(apps.list(), appId, parseEnvFromUrl(req.url));
    registry.register({
      instanceId,
      appId,
      serviceId,
      env,
      socket: ws,
      connectedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
    });
    console.info(
      `[downstream] online app=${appId} instance=${instanceId} env=${env} total=${registry.list(appId).length}`,
    );

    ws.on("message", async (data) => {
      registry.touch(ws);
      try {
        const buf = Buffer.isBuffer(data)
          ? data
          : Buffer.from(data as ArrayBuffer);
        const frame = decodeFrame(new Uint8Array(buf));
        const type = getHeader(frame.headers, HeaderKey.type);

        if (frame.method === FrameType.control && type === MessageType.ping) {
          const pong = buildPongFrame(serviceId, {
            PingInterval: config.ws.pingIntervalSec,
            ReconnectCount: config.ws.reconnectCount,
            ReconnectInterval: config.ws.reconnectIntervalSec,
            ReconnectNonce: config.ws.reconnectNonceSec,
          });
          ws.send(encodeFrame(pong));
          return;
        }

        if (frame.method === FrameType.data) {
          const messageId = getHeader(frame.headers, HeaderKey.message_id);
          if (!messageId) return;
          const pending = pendingAcks.get(messageId);
          if (!pending) return;
          clearTimeout(pending.timer);
          pendingAcks.delete(messageId);
          let payload: unknown = null;
          if (frame.payload && frame.payload.length > 0) {
            try {
              payload = JSON.parse(new TextDecoder().decode(frame.payload));
            } catch {
              payload = null;
            }
          }
          pending.resolve(payload);
        }
      } catch (err) {
        console.error("[downstream] message error", err);
      }
    });

    ws.on("close", () => {
      const removed = registry.unregister(ws);
      if (removed) {
        console.info(
          `[downstream] offline app=${removed.appId} instance=${removed.instanceId}`,
        );
      }
    });

    ws.on("error", (err) => {
      console.error("[downstream] socket error", err.message);
    });
  });

  const sweep = setInterval(() => {
    const expired = registry.sweepExpired(config.ws.instanceTtlMs);
    for (const inst of expired) {
      console.info(
        `[downstream] expired app=${inst.appId} instance=${inst.instanceId}`,
      );
    }
  }, 30_000);
  sweep.unref?.();

  return {
    wss,
    pendingAcks,
    async sendEventAndWaitAck({
      appId,
      instanceId,
      messageId,
      traceId,
      payload,
      timeoutMs,
    }) {
      const instance = registry.get(appId, instanceId);
      if (!instance) throw new Error(`instance not found: ${instanceId}`);
      if (instance.socket.readyState !== instance.socket.OPEN) {
        throw new Error(`instance socket not open: ${instanceId}`);
      }

      const frame = buildEventFrame({
        serviceId: instance.serviceId,
        messageId,
        traceId,
        payload,
      });

      const ackPromise = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingAcks.delete(messageId);
          reject(new Error(`ack timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        pendingAcks.set(messageId, { resolve, reject, timer });
      });

      instance.socket.send(encodeFrame(frame));
      return ackPromise;
    },
    sendEvent({ appId, instanceId, messageId, traceId, payload }) {
      const instance = registry.get(appId, instanceId);
      if (!instance) throw new Error(`instance not found: ${instanceId}`);
      if (instance.socket.readyState !== instance.socket.OPEN) {
        throw new Error(`instance socket not open: ${instanceId}`);
      }
      const frame = buildEventFrame({
        serviceId: instance.serviceId,
        messageId,
        traceId,
        payload,
      });
      instance.socket.send(encodeFrame(frame));
    },
    async close() {
      clearInterval(sweep);
      for (const [, pending] of pendingAcks) {
        clearTimeout(pending.timer);
        pending.reject(new Error("server closing"));
      }
      pendingAcks.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
