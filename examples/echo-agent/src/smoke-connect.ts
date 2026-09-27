/**
 * Minimal agent that uses the official SDK with only `domain` overridden.
 * Used for local smoke tests against the gateway.
 */
import * as Lark from "@larksuiteoapi/node-sdk";

const appId = process.env.LARK_APP_ID ?? "cli_a1b2c3d4e5f67890";
const appSecret = process.env.LARK_APP_SECRET ?? "test_secret";
const domain = process.env.LARK_DOMAIN ?? "http://127.0.0.1:18787";
const instanceName = process.env.INSTANCE_NAME ?? `smoke-${process.pid}`;

const client = new Lark.Client({ appId, appSecret, domain });
const wsClient = new Lark.WSClient({
  appId,
  appSecret,
  domain,
  loggerLevel: Lark.LoggerLevel.info,
});

let gotEvent = false;

console.info(`[${instanceName}] connecting domain=${domain}`);

await wsClient.start({
  eventDispatcher: new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data) => {
      gotEvent = true;
      const userId = data.sender?.sender_id?.user_id ?? "unknown";
      console.info(`[${instanceName}] got event user=${userId}`);
      // Probe HTTP via gateway domain
      try {
        await client.auth.tenantAccessToken.internal({
          data: { app_id: appId, app_secret: appSecret },
        });
      } catch (err) {
        console.info(
          `[${instanceName}] token call via gateway (expected fail with test creds):`,
          err instanceof Error ? err.message : err,
        );
      }
    },
  }),
});

console.info(`[${instanceName}] ws ready`);

// Keep alive for parent script
setInterval(() => {
  if (gotEvent) {
    // no-op heartbeat log
  }
}, 10_000).unref();
