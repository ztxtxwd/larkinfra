import fs from "node:fs";
import YAML from "yaml";
import { findUpFile, loadEnv } from "./env.js";
import { parseListen } from "./config.js";

export interface AgentRuntimeConfig {
  appId: string;
  appSecret: string;
  domain: string;
  configPath?: string;
}

/**
 * Agent 侧凭证：仅来自环境变量 / `.env`。
 * `config.yaml` 只用于推导网关地址；网关不预配 apps —— Agent 接入时自动注册。
 */
export function loadAgentRuntimeConfig(): AgentRuntimeConfig {
  loadEnv();

  const configPath =
    process.env.LARKINFRA_CONFIG ?? findUpFile("config.yaml");
  let fileDomain: string | undefined;

  if (configPath && fs.existsSync(configPath)) {
    const raw = (YAML.parse(fs.readFileSync(configPath, "utf8")) ??
      {}) as Record<string, unknown>;

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

  const appId = process.env.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET;
  const domain =
    process.env.LARK_DOMAIN ?? fileDomain ?? "http://127.0.0.1:18787";

  if (!appId || !appSecret) {
    throw new Error(
      "缺少 app 凭证：请设置 LARK_APP_ID / LARK_APP_SECRET（推荐根目录 .env）",
    );
  }

  return { appId, appSecret, domain, configPath };
}
