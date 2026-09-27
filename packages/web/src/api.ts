export type Tab = "events" | "http" | "instances" | "remarks";

export type UserTag = "developer" | "tester" | "user";

export const USER_TAG_OPTIONS: { value: UserTag; label: string }[] = [
  { value: "developer", label: "开发者" },
  { value: "tester", label: "测试者" },
  { value: "user", label: "普通用户" },
];

export function userTagLabel(tag: UserTag | string | null | undefined): string {
  const found = USER_TAG_OPTIONS.find((o) => o.value === tag);
  return found?.label ?? "普通用户";
}

export interface EventRow {
  trace_id: string;
  app_id: string;
  event_type: string | null;
  user_id: string | null;
  instance_id: string | null;
  status: string;
  payload: string | null;
  error: string | null;
  received_at: string;
  routed_at: string | null;
  acked_at: string | null;
}

export interface HttpRow {
  trace_id: string;
  app_id: string | null;
  method: string;
  path: string;
  status_code: number;
  duration_ms: number;
  request_snippet: string | null;
  response_snippet: string | null;
  created_at: string;
}

export interface InstanceRow {
  appId: string;
  instanceId: string;
  env: "dev" | "test" | "staging" | "prod";
  connectedAt: number;
  lastHeartbeatAt: number;
  draining?: boolean;
}

export interface Health {
  ok: boolean;
  apps: string[];
  instances: InstanceRow[];
}

export interface UserRemarkRow {
  user_id: string;
  remark: string;
  updated_at: string;
}

export interface UserTagRow {
  user_id: string;
  tag: UserTag;
  updated_at: string;
}

const TOKEN_KEY = "larkinfra.adminToken";

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "dev-token";
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "x-admin-token": getToken(),
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export function fetchHealth() {
  return api<Health>("/admin/health");
}

export function fetchEvents(params: {
  userId?: string;
  eventType?: string;
  limit?: number;
}) {
  const q = new URLSearchParams();
  if (params.userId) q.set("user_id", params.userId);
  if (params.eventType) q.set("event_type", params.eventType);
  q.set("limit", String(params.limit ?? 80));
  return api<{ rows: EventRow[] }>(`/admin/traces/events?${q}`);
}

export function fetchHttp(params: { path?: string; limit?: number }) {
  const q = new URLSearchParams();
  if (params.path) q.set("path", params.path);
  q.set("limit", String(params.limit ?? 80));
  return api<{ rows: HttpRow[] }>(`/admin/traces/http?${q}`);
}

export function fetchUserRemarks() {
  return api<{ rows: UserRemarkRow[] }>("/admin/users/remarks");
}

export function putUserRemark(userId: string, remark: string) {
  return api<{ ok: true; row: UserRemarkRow }>(
    `/admin/users/${encodeURIComponent(userId)}/remark`,
    { method: "PUT", body: JSON.stringify({ remark }) },
  );
}

export function deleteUserRemark(userId: string) {
  return api<{ ok: true; userId: string }>(
    `/admin/users/${encodeURIComponent(userId)}/remark`,
    { method: "DELETE" },
  );
}

export function fetchUserTags() {
  return api<{ rows: UserTagRow[] }>("/admin/users/tags");
}

export function putUserTag(userId: string, tag: UserTag) {
  return api<{ ok: true; row: UserTagRow }>(
    `/admin/users/${encodeURIComponent(userId)}/tag`,
    { method: "PUT", body: JSON.stringify({ tag }) },
  );
}

export function deleteUserTag(userId: string) {
  return api<{ ok: true; userId: string }>(
    `/admin/users/${encodeURIComponent(userId)}/tag`,
    { method: "DELETE" },
  );
}

export type AgentSignal = "graceful" | "force";

export interface SignalInstanceResult {
  ok: true;
  signal: AgentSignal;
  instanceId: string;
  status: "signaled" | "offline" | "timeout" | "terminated";
  draining?: boolean;
}

/** Offline an agent via lifecycle signal (marks draining first). */
export function signalInstance(
  appId: string,
  instanceId: string,
  signal: AgentSignal,
  opts?: { reason?: string; waitOfflineMs?: number },
) {
  return api<SignalInstanceResult>(
    `/admin/apps/${encodeURIComponent(appId)}/instances/${encodeURIComponent(instanceId)}/signal`,
    {
      method: "POST",
      body: JSON.stringify({
        signal,
        reason: opts?.reason ?? "web_ui",
        waitOfflineMs: opts?.waitOfflineMs ?? 0,
      }),
    },
  );
}
