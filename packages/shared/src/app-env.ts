/**
 * Environment of one agent process, declared at startup.
 * The same appId may have dev / test / staging / prod instances online together.
 * - dev: 开发调试
 * - test: 测试 / QA
 * - staging: 预发 / 验收（也接受 stage）
 * - prod: 正式线上
 */
export const APP_ENVS = ["dev", "test", "staging", "prod"] as const;

export type AppEnv = (typeof APP_ENVS)[number];

const ALIASES: Record<string, AppEnv> = {
  dev: "dev",
  development: "dev",
  local: "dev",
  test: "test",
  testing: "test",
  qa: "test",
  staging: "staging",
  stage: "staging",
  pre: "staging",
  preview: "staging",
  uat: "staging",
  prod: "prod",
  production: "prod",
  online: "prod",
};

export function isAppEnv(value: string): value is AppEnv {
  return (APP_ENVS as readonly string[]).includes(value);
}

/** Parse a free-form env string; returns `undefined` when empty/unknown. */
export function tryParseAppEnv(
  value: string | undefined | null,
): AppEnv | undefined {
  if (!value) return undefined;
  const key = value.trim().toLowerCase();
  if (!key) return undefined;
  return ALIASES[key] ?? (isAppEnv(key) ? key : undefined);
}

/** Parse a free-form env string; returns `fallback` when empty/unknown. */
export function parseAppEnv(
  value: string | undefined | null,
  fallback: AppEnv = "dev",
): AppEnv {
  return tryParseAppEnv(value) ?? fallback;
}

/**
 * Official SDK builds `{domain}/callback/ws/endpoint` and `{domain}/open-apis/...`.
 * Embedding `/e/{env}` in `domain` is how a process tells the gateway its env
 * without a custom handshake field.
 */
export function domainWithEnv(domain: string, env: AppEnv): string {
  const raw = domain.trim().replace(/\/+$/, "");
  const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
  const stripped = url.pathname.replace(/\/e\/[^/]+\/?$/, "");
  const basePath = stripped === "/" ? "" : stripped.replace(/\/$/, "");
  url.pathname = `${basePath}/e/${env}`;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

/**
 * Split a request path that may start with `/e/{env}`.
 * Unknown env labels are returned as `invalidEnv` and are not stripped.
 */
export function peelEnvPrefix(pathname: string): {
  pathname: string;
  env?: AppEnv;
  invalidEnv?: string;
} {
  const match = pathname.match(/^\/e\/([^/]+)(\/.*)$/);
  if (!match) return { pathname };
  const raw = decodeURIComponent(match[1] ?? "");
  const env = tryParseAppEnv(raw);
  if (!env) return { pathname, invalidEnv: raw || match[1] };
  return { pathname: match[2] ?? "/", env };
}
