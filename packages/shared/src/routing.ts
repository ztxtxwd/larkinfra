import { createHash } from "node:crypto";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function dig(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * Actor paths for user-triggered Feishu events / callbacks.
 * Docs live under each business domain (消息 / 群组 / 云文档 / …), not a single list.
 *
 * Shapes covered (prefer union_id):
 * - 消息 receive → event.sender.sender_id
 * - 消息 reaction → event.user_id (id bag)
 * - 消息 read → event.reader.reader_id
 * - 机器人菜单 / 卡片回调 → event.operator(.operator_id | flat)
 * - 群组 chat.* → event.operator_id
 * - 云文档 file edit/read → event.operator_id_list[0]
 * - 视频会议 → event.operator.id
 * - 日历变更 → event.user_id_list[0] / rsvp from_user_id
 * - 通讯录员工入职等 → event.object
 */
const ACTOR_PATHS: string[][] = [
  ["event", "sender"],
  ["event", "operator"],
  ["event", "operator_id"],
  ["event", "operator_id_list"],
  ["event", "reader"],
  ["event", "user_id"],
  ["event", "user"],
  ["event", "object"],
  ["event", "from_user_id"],
  ["event", "creator_id"],
  ["event", "owner_id"],
  ["event", "operator_user_id"],
  ["event", "user_id_list"],
  ["event", "open_id"],
  ["sender"],
  ["operator"],
  ["operator_id"],
  ["operator_id_list"],
  ["reader"],
  ["user_id"],
  ["user"],
  ["object"],
  ["creator_id"],
  ["owner_id"],
  ["operator_user_id"],
  ["user_id_list"],
];

const ID_KEYS = ["union_id", "user_id", "open_id"] as const;
const NEST_KEYS = [
  "sender_id",
  "operator_id",
  "reader_id",
  "from_user_id",
  "user_id",
  "id",
] as const;

/** Prefer union_id; unwrap id bags, wrappers, and id lists. */
export function pickUserId(value: unknown, depth = 0): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (value == null || depth > 4) return undefined;

  if (Array.isArray(value)) {
    for (const item of value) {
      const id = pickUserId(item, depth + 1);
      if (id) return id;
    }
    return undefined;
  }

  if (typeof value !== "object") return undefined;
  const bag = value as Record<string, unknown>;

  for (const key of ID_KEYS) {
    const v = bag[key];
    if (typeof v === "string" && v.length > 0) return v;
  }

  for (const nest of NEST_KEYS) {
    if (!(nest in bag)) continue;
    const nested = pickUserId(bag[nest], depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

export function extractUserId(payload: unknown): string | undefined {
  for (const path of ACTOR_PATHS) {
    const id = pickUserId(dig(payload, path));
    if (id) return id;
  }

  // Last resort: scan event one level (skip bulk participant lists).
  const event = dig(payload, ["event"]);
  if (event && typeof event === "object" && !Array.isArray(event)) {
    for (const [key, value] of Object.entries(
      event as Record<string, unknown>,
    )) {
      if (
        key === "users" ||
        key === "mentions" ||
        key === "subscriber" ||
        key === "subscriber_id_list" ||
        key === "rsvp_infos"
      ) {
        continue;
      }
      // Prefer actor-named lists; skip other *_list noise except known ones.
      if (
        key.endsWith("_list") &&
        key !== "operator_id_list" &&
        key !== "user_id_list"
      ) {
        continue;
      }
      const id = pickUserId(value);
      if (id) return id;
    }
  }
  return undefined;
}

export function extractEventType(payload: unknown): string | undefined {
  const header = dig(payload, ["header", "event_type"]);
  if (typeof header === "string") return header;
  const type = dig(payload, ["type"]);
  if (typeof type === "string") return type;
  return undefined;
}

export function extractEventId(payload: unknown): string | undefined {
  const eventId = dig(payload, ["header", "event_id"]);
  if (typeof eventId === "string") return eventId;
  return undefined;
}

export function routingKey(payload: unknown): string {
  return (
    extractUserId(payload) ??
    extractEventId(payload) ??
    JSON.stringify(payload as Json).slice(0, 64)
  );
}

/** FNV-1a 32-bit for stable consistent hashing. */
export function hashKey(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function pickInstanceId(
  key: string,
  instanceIds: string[],
): string | undefined {
  if (instanceIds.length === 0) return undefined;
  const sorted = [...instanceIds].sort();
  const idx = hashKey(key) % sorted.length;
  return sorted[idx];
}

export function sha256Short(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export function truncate(text: string, max = 4096): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}
