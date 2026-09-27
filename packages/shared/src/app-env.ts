/**
 * Environment of a Feishu/Lark application instance.
 * Typically each appId (or credential set) maps to one of these:
 * - dev: 开发调试用应用
 * - test: 测试/QA 应用
 * - staging: 预发/验收应用
 * - prod: 正式线上应用
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
