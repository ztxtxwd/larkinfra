import { APP_ENVS, type AppEnv } from "./app-env.js";

/**
 * User routing preference tags.
 * Preference is an env ladder start point; gateway walks upward
 * (dev → test → staging → prod) until an online instance pool exists.
 */
export const USER_TAGS = ["developer", "tester", "user"] as const;

export type UserTag = (typeof USER_TAGS)[number];

/** Preferred env start for each tag (then walk APP_ENVS upward). */
const TAG_START: Record<UserTag, AppEnv> = {
  developer: "dev",
  tester: "test",
  user: "prod",
};

export function isUserTag(value: string): value is UserTag {
  return (USER_TAGS as readonly string[]).includes(value);
}

export function tryParseUserTag(
  value: string | undefined | null,
): UserTag | undefined {
  if (!value) return undefined;
  const key = value.trim().toLowerCase();
  if (!key) return undefined;
  if (key === "developer" || key === "dev" || key === "开发者") {
    return "developer";
  }
  if (key === "tester" || key === "test" || key === "qa" || key === "测试者") {
    return "tester";
  }
  if (
    key === "user" ||
    key === "regular" ||
    key === "normal" ||
    key === "普通用户"
  ) {
    return "user";
  }
  return isUserTag(key) ? key : undefined;
}

/** Missing / unknown tag defaults to ordinary user (prod preference). */
export function resolveUserTag(
  tag: string | UserTag | null | undefined,
): UserTag {
  if (tag == null) return "user";
  return tryParseUserTag(typeof tag === "string" ? tag : tag) ?? "user";
}

/**
 * Env preference chain for a tag, from preferred down toward prod.
 * e.g. developer → [dev, test, staging, prod]
 */
export function preferEnvChain(tag?: string | UserTag | null): AppEnv[] {
  const resolved = resolveUserTag(tag);
  const start = TAG_START[resolved];
  const idx = APP_ENVS.indexOf(start);
  if (idx < 0) return [...APP_ENVS];
  return APP_ENVS.slice(idx);
}

/**
 * Pick the first env in the preference chain that appears in `available`.
 * Returns undefined when none of the preferred envs are available.
 */
export function pickPreferredEnv(
  tag: string | UserTag | null | undefined,
  available: Iterable<AppEnv>,
): AppEnv | undefined {
  const set = new Set(available);
  for (const env of preferEnvChain(tag)) {
    if (set.has(env)) return env;
  }
  return undefined;
}
