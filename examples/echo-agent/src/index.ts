import {
  SIGNAL_EVENT_TYPES,
  loadAgentRuntimeConfig,
} from "@larkinfra/shared";
import * as Lark from "@larksuiteoapi/node-sdk";

let runtime;
try {
  runtime = loadAgentRuntimeConfig();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const { appId, appSecret, domain, configPath } = runtime;
const instanceName = process.env.INSTANCE_NAME ?? `agent-${process.pid}`;

const client = new Lark.Client({
  appId,
  appSecret,
  domain,
});

const wsClient = new Lark.WSClient({
  appId,
  appSecret,
  domain,
  loggerLevel: Lark.LoggerLevel.info,
});

console.info(
  `[${instanceName}] domain=${domain} appId=${appId}` +
    (configPath ? ` config=${configPath}` : ""),
);

/** In-flight business handlers; drained on graceful exit. */
const inflight = new Set<Promise<unknown>>();
let shuttingDown = false;

const exitNow = (label: string) => {
  console.info(`[${instanceName}] ${label}: exiting`);
  try {
    wsClient.close({ force: true });
  } catch {
    // ignore
  }
  process.exit(label === "force" ? 1 : 0);
};

/** Graceful: finish in-flight work, then close WS and exit. */
const shutdownGraceful = async (source: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(
    `[${instanceName}] graceful via ${source}, draining ${inflight.size} in-flight...`,
  );

  if (inflight.size > 0) {
    const drainMs = Number(process.env.SHUTDOWN_DRAIN_MS ?? 3_600_000);
    await Promise.race([
      Promise.allSettled([...inflight]),
      new Promise<void>((resolve) => setTimeout(resolve, drainMs)),
    ]);
  }

  try {
    wsClient.close();
  } catch (err) {
    console.error(
      `[${instanceName}] ws close error:`,
      err instanceof Error ? err.message : err,
    );
  }
  console.info(`[${instanceName}] graceful shutdown complete`);
  process.exit(0);
};

/** Force: skip drain, drop WS, exit immediately. */
const shutdownForce = (source: string) => {
  if (shuttingDown) {
    exitNow("force");
    return;
  }
  shuttingDown = true;
  console.info(`[${instanceName}] force via ${source}, skipping drain`);
  exitNow("force");
};

wsClient.start({
  eventDispatcher: new Lark.EventDispatcher({}).register({
    [SIGNAL_EVENT_TYPES.graceful]: async (data: { reason?: string }) => {
      // Return quickly so SDK can ACK; drain runs after this tick.
      console.info(
        `[${instanceName}] gateway signal graceful reason=${data?.reason ?? ""}`,
      );
      void shutdownGraceful("ws");
    },
    [SIGNAL_EVENT_TYPES.force]: async (data: { reason?: string }) => {
      console.info(
        `[${instanceName}] gateway signal force reason=${data?.reason ?? ""}`,
      );
      // Defer one tick so ACK can flush before we tear down the socket.
      setTimeout(() => shutdownForce("ws"), 0);
    },
    "im.message.receive_v1": async (data) => {
      if (shuttingDown) return;

      const work = (async () => {
        const senderId =
          data.sender?.sender_id?.user_id ??
          data.sender?.sender_id?.open_id ??
          "unknown";
        const chatId = data.message?.chat_id;
        const contentRaw = data.message?.content ?? "{}";
        let text = contentRaw;
        try {
          text = JSON.parse(contentRaw).text ?? contentRaw;
        } catch {
          // keep raw
        }

        console.info(
          `[${instanceName}] event from user=${senderId} chat=${chatId} text=${text}`,
        );

        if (!chatId) return;

        await client.im.v1.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: chatId,
            msg_type: "text",
            content: JSON.stringify({
              text: `[${instanceName}] echo: ${text}`,
            }),
          },
        });
      })();

      inflight.add(work);
      try {
        await work;
      } finally {
        inflight.delete(work);
      }
    },
  }),
});

// Local process signals map to the same semantics (dev / bare metal).
process.once("SIGTERM", () => void shutdownGraceful("os:SIGTERM"));
process.once("SIGINT", () => shutdownForce("os:SIGINT"));
