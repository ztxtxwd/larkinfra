import fs from "node:fs";
import YAML from "yaml";
import {
  GatewayConfigSchema,
  findUpFile,
  type GatewayConfig,
} from "@larkinfra/shared";

export function loadConfig(configPath?: string): GatewayConfig {
  const resolved =
    configPath ??
    process.env.LARKINFRA_CONFIG ??
    findUpFile("config.yaml");

  let raw: unknown = {};
  if (resolved && fs.existsSync(resolved)) {
    const text = fs.readFileSync(resolved, "utf8");
    raw = YAML.parse(text) ?? {};
    console.info(`[config] loaded ${resolved}`);
  } else {
    console.warn(
      `[config] config.yaml not found (searched from ${process.cwd()} upward), using defaults/env`,
    );
  }

  // Apps are registered at agent connect time. Optional bootstrap only via
  // config.yaml `apps:` — do NOT seed from LARK_APP_ID (that is agent-side).
  const rawObj =
    typeof raw === "object" && raw ? (raw as Record<string, unknown>) : {};

  const merged = {
    ...rawObj,
    listen: process.env.LARKINFRA_LISTEN ?? (rawObj as GatewayConfig).listen,
    publicHost:
      process.env.LARKINFRA_PUBLIC_HOST ??
      (rawObj as GatewayConfig).publicHost,
    apps: (rawObj as GatewayConfig).apps ?? [],
    admin: {
      token:
        process.env.LARKINFRA_ADMIN_TOKEN ??
        (rawObj as { admin?: { token?: string } })?.admin?.token ??
        "dev-token",
    },
    upstream: {
      domain:
        process.env.LARK_UPSTREAM_DOMAIN ??
        (rawObj as { upstream?: { domain?: string } })?.upstream?.domain ??
        "https://open.feishu.cn",
    },
  };

  return GatewayConfigSchema.parse(merged);
}
