import { z } from "zod";
import { APP_ENVS, parseAppEnv, type AppEnv } from "./app-env.js";

/** Accepts aliases like `development` / `production` and normalizes to AppEnv. */
export const AppEnvSchema = z.preprocess(
  (v) => (typeof v === "string" ? parseAppEnv(v) : v),
  z.enum(APP_ENVS),
) as z.ZodType<AppEnv>;

export const AppConfigSchema = z.object({
  appId: z.string().min(1),
  appSecret: z.string().min(1),
  upstreamConnections: z.number().int().min(0).default(1),
  /**
   * Feishu application environment this appId belongs to
   * (dev / test / staging / prod). Inherited by connected agent instances.
   */
  env: AppEnvSchema.default("dev"),
});

/** Defaults applied when an app auto-registers via agent connect. */
export const AppDefaultsSchema = z
  .object({
    env: AppEnvSchema.default("dev"),
    upstreamConnections: z.number().int().min(0).default(1),
  })
  .default({});

export const GatewayConfigSchema = z.object({
  listen: z.string().default(":18787"),
  publicHost: z.string().optional(),
  upstream: z
    .object({
      domain: z.string().url().default("https://open.feishu.cn"),
    })
    .default({ domain: "https://open.feishu.cn" }),
  duckdb: z
    .object({
      path: z.string().default("./data/larkinfra.duckdb"),
      storeBodies: z.boolean().default(true),
      bodyMaxChars: z.number().int().positive().default(4096),
    })
    .default({}),
  /**
   * Defaults for apps registered at connect time. Apps are never preconfigured:
   * agents bring AppID/AppSecret on `/callback/ws/endpoint`.
   */
  appDefaults: AppDefaultsSchema,
  routing: z
    .object({
      strategy: z.literal("consistent_hash").default("consistent_hash"),
      key: z.literal("user_id").default("user_id"),
      ackTimeoutMs: z.number().int().positive().default(2500),
    })
    .default({}),
  admin: z
    .object({
      token: z.string().default("dev-token"),
    })
    .default({}),
  ws: z
    .object({
      serviceId: z.number().int().positive().default(33554678),
      pingIntervalSec: z.number().int().positive().default(90),
      reconnectCount: z.number().int().default(-1),
      reconnectIntervalSec: z.number().int().positive().default(90),
      reconnectNonceSec: z.number().int().positive().default(25),
      instanceTtlMs: z.number().int().positive().default(180_000),
      /**
       * Close an app's Feishu upstream if no agent instance connects within
       * this window after the endpoint handshake started it.
       */
      upstreamIdleTimeoutMs: z.number().int().positive().default(60_000),
    })
    .default({}),
});

/** Resolve Feishu app env for an instance: URL override → registered app.env → `dev`. */
export function resolveAppEnv(
  apps: Array<{ appId: string; env: AppEnv }>,
  appId: string,
  override?: string | string[] | null,
): AppEnv {
  const app = apps.find((a) => a.appId === appId);
  const fallback = app?.env ?? "dev";
  const raw = Array.isArray(override) ? override[0] : override;
  if (raw) return parseAppEnv(raw, fallback);
  return fallback;
}

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;

export function parseListen(listen: string): { host: string; port: number } {
  if (listen.startsWith(":")) {
    return { host: "0.0.0.0", port: Number(listen.slice(1)) };
  }
  const url = listen.includes("://") ? new URL(listen) : new URL(`http://${listen}`);
  return {
    host: url.hostname || "0.0.0.0",
    port: Number(url.port || 18787),
  };
}
