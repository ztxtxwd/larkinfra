import fs from "node:fs";
import YAML from "yaml";
import { domainWithEnv, parseAppEnv, tryParseAppEnv, type AppEnv } from "./app-env.js";
import { findUpFile, loadEnv } from "./env.js";
import { parseListen } from "./config.js";

export interface AgentRuntimeConfig {
  appId: string;
  appSecret: string;
  /** Domain passed to the official SDK, including `/e/{env}`. */
  domain: string;
  env: AppEnv;
  configPath?: string;
}

/**
 * Agent 侧凭证：优先环境变量 / `.env`。
 * 若仍存在旧版 `config.yaml` 的 `apps[0]`，作为兼容回退。
 * 网关侧不再要求预配 apps —— Agent 接入时自动注册。
 */
export function loadAgentRuntimeConfig(): AgentRuntimeConfig {
  loadEnv();

  const configPath =
    process.env.LARKINFRA_CONFIG ?? findUpFile("config.yaml");
  let fileAppId: string | undefined;
  let fileAppSecret: string | undefined;
  let fileDomain: string | undefined;

  if (configPath && fs.existsSync(configPath)) {
    const raw = (YAML.parse(fs.readFileSync(configPath, "utf8")) ??
      {}) as Record<string, unknown>;
    const apps = raw.apps as
      | Array<{ appId?: string; appSecret?: string }>
      | undefined;
    const first = apps?.[0];
    fileAppId = first?.appId;
    fileAppSecret = first?.appSecret;

    const publicHost =
      typeof raw.publicHost === "string" ? raw.publicHost : undefined;
    if (publicHost) {
      fileDomain = publicHost.replace(/\/$/, "");
    } else {
      const listen =
        typeof raw.listen === "string" ? raw.listen : ":18787";
      const { port } = parseListen(listen);
      fileDomain = `http://127.0.0.1:${port}`;
    }
  }

  const appId = process.env.LARK_APP_ID ?? fileAppId;
  const appSecret = process.env.LARK_APP_SECRET ?? fileAppSecret;
  const baseDomain =
    process.env.LARK_DOMAIN ?? fileDomain ?? "http://127.0.0.1:18787";

  if (!appId || !appSecret) {
    throw new Error(
      "缺少 app 凭证：请设置 LARK_APP_ID / LARK_APP_SECRET（推荐根目录 .env），或在 config.yaml 的 apps[0] 填写（兼容旧配置）",
    );
  }

  const rawEnv = process.env.LARK_APP_ENV?.trim();
  if (rawEnv && !tryParseAppEnv(rawEnv)) {
    throw new Error(
      `LARK_APP_ENV 无法识别：${rawEnv}。可用 dev、test、staging、prod（stage 视为 staging）`,
    );
  }
  const env = parseAppEnv(rawEnv, "dev");
  const domain = domainWithEnv(baseDomain, env);

  return { appId, appSecret, domain, env, configPath };
}
