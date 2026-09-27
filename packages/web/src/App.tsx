import { useEffect, useMemo, useState } from "react";
import {
  deleteUserRemark,
  deleteUserTag,
  fetchEvents,
  fetchHealth,
  fetchHttp,
  fetchUserRemarks,
  fetchUserTags,
  getToken,
  putUserRemark,
  putUserTag,
  setToken,
  signalInstance,
  USER_TAG_OPTIONS,
  userTagLabel,
  type AgentSignal,
  type EventRow,
  type Health,
  type HttpRow,
  type InstanceRow,
  type Tab,
  type UserRemarkRow,
  type UserTag,
  type UserTagRow,
} from "./api";

function fmtTime(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function StatusPill({ status }: { status: string }) {
  const cls =
    status === "acked" || status === "ok"
      ? "acked"
      : status === "failed" || status === "dropped"
        ? "failed"
        : status === "pending" || status === "routed"
          ? "pending"
          : "info";
  return <span className={`pill ${cls}`}>{status}</span>;
}

function truncate(text: string | null | undefined, n = 180): string {
  if (!text) return "—";
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

/** Display user for rows stored before extraction covered this event shape. */
function resolveUserId(row: EventRow): string | null {
  if (row.user_id) return row.user_id;
  if (!row.payload) return null;
  try {
    const payload = JSON.parse(row.payload) as unknown;
    return extractUserIdFromPayload(payload) ?? null;
  } catch {
    return null;
  }
}

const ID_KEYS = ["union_id", "user_id", "open_id"] as const;
const NEST_KEYS = [
  "sender_id",
  "operator_id",
  "reader_id",
  "from_user_id",
  "user_id",
  "id",
] as const;
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
];

function dig(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function pickUserId(value: unknown, depth = 0): string | undefined {
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

function extractUserIdFromPayload(payload: unknown): string | undefined {
  for (const path of ACTOR_PATHS) {
    const id = pickUserId(dig(payload, path));
    if (id) return id;
  }
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

function UserLabel({
  userId,
  remarks,
  tags,
  onEdit,
}: {
  userId: string | null;
  remarks: Record<string, string>;
  tags: Record<string, UserTag>;
  onEdit?: (userId: string) => void;
}) {
  if (!userId) return <span className="mono">—</span>;
  const remark = remarks[userId];
  const tag = tags[userId] ?? "user";
  return (
    <button
      type="button"
      className="user-label"
      title={
        remark
          ? `${remark} · ${userTagLabel(tag)} · ${userId}`
          : `设置备注/标签 · ${userId}`
      }
      onClick={(e) => {
        e.stopPropagation();
        onEdit?.(userId);
      }}
    >
      <span className={`pill tag-${tag}`}>{userTagLabel(tag)}</span>
      {remark ? (
        <span className="user-remark">{remark}</span>
      ) : (
        <span className="mono">{userId}</span>
      )}
    </button>
  );
}

export function App() {
  const [tab, setTab] = useState<Tab>("events");
  const [tokenInput, setTokenInput] = useState(getToken());
  const [userId, setUserId] = useState("");
  const [eventType, setEventType] = useState("");
  const [pathFilter, setPathFilter] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [httpRows, setHttpRows] = useState<HttpRow[]>([]);
  const [remarks, setRemarks] = useState<UserRemarkRow[]>([]);
  const [tags, setTags] = useState<UserTagRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [remarkDraft, setRemarkDraft] = useState<{
    userId: string;
    remark: string;
    tag: UserTag;
  }>({ userId: "", remark: "", tag: "user" });
  const [remarkBusy, setRemarkBusy] = useState(false);
  const [signalBusyId, setSignalBusyId] = useState<string | null>(null);

  const remarkMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const row of remarks) map[row.user_id] = row.remark;
    return map;
  }, [remarks]);

  const tagMap = useMemo(() => {
    const map: Record<string, UserTag> = {};
    for (const row of tags) map[row.user_id] = row.tag;
    return map;
  }, [tags]);

  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 2500);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [h, ev, http, rm, tg] = await Promise.all([
          fetchHealth(),
          fetchEvents({
            userId: userId || undefined,
            eventType: eventType || undefined,
          }),
          fetchHttp({ path: pathFilter || undefined }),
          fetchUserRemarks(),
          fetchUserTags(),
        ]);
        if (cancelled) return;
        setHealth(h);
        setEvents(ev.rows);
        setHttpRows(http.rows);
        setRemarks(rm.rows);
        setTags(tg.rows);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick, userId, eventType, pathFilter, tokenInput]);

  const counts = useMemo(() => {
    const byStatus = events.reduce<Record<string, number>>((acc, row) => {
      acc[row.status] = (acc[row.status] ?? 0) + 1;
      return acc;
    }, {});
    return {
      apps: health?.apps.length ?? 0,
      instances: health?.instances.length ?? 0,
      events: events.length,
      http: httpRows.length,
      remarks: remarks.length,
      tags: tags.length,
      acked: byStatus.acked ?? 0,
      failed: (byStatus.failed ?? 0) + (byStatus.dropped ?? 0),
    };
  }, [health, events, httpRows, remarks, tags]);

  function openRemarkEditor(id: string) {
    setRemarkDraft({
      userId: id,
      remark: remarkMap[id] ?? "",
      tag: tagMap[id] ?? "user",
    });
    setTab("remarks");
  }

  async function saveRemark() {
    const id = remarkDraft.userId.trim();
    const name = remarkDraft.remark.trim();
    if (!id) {
      setError("请填写 user_id");
      return;
    }
    setRemarkBusy(true);
    try {
      await putUserTag(id, remarkDraft.tag);
      if (name) {
        await putUserRemark(id, name);
      }
      setRemarkDraft({ userId: "", remark: "", tag: "user" });
      setTick((t) => t + 1);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemarkBusy(false);
    }
  }

  async function removeRemark(id: string) {
    setRemarkBusy(true);
    try {
      await deleteUserRemark(id);
      if (remarkDraft.userId === id) {
        setRemarkDraft((d) => ({ ...d, remark: "" }));
      }
      setTick((t) => t + 1);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemarkBusy(false);
    }
  }

  async function removeTag(id: string) {
    setRemarkBusy(true);
    try {
      await deleteUserTag(id);
      if (remarkDraft.userId === id) {
        setRemarkDraft((d) => ({ ...d, tag: "user" }));
      }
      setTick((t) => t + 1);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemarkBusy(false);
    }
  }

  async function offlineInstance(row: InstanceRow, signal: AgentSignal) {
    if (signal === "force") {
      const ok = window.confirm(
        `强制下线实例 ${row.instanceId.slice(0, 8)}…？\n将立即掐断 WS，不等待 in-flight。`,
      );
      if (!ok) return;
    } else {
      const ok = window.confirm(
        `优雅下线实例 ${row.instanceId.slice(0, 8)}…？\n先停止分流，待 Agent 完成 in-flight 后退出。`,
      );
      if (!ok) return;
    }
    setSignalBusyId(row.instanceId);
    try {
      await signalInstance(row.appId, row.instanceId, signal);
      setTick((t) => t + 1);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSignalBusyId(null);
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-kicker">LarkInfra · Trace Console</div>
          <h1>事件与请求观测台</h1>
          <p>
            实时查看网关捕获的飞书事件分流与出站 HTTP 调用。数据来自 DuckDB
            traces。
          </p>
        </div>
        <div className="controls">
          <span className="live">
            <i /> live · 2.5s
          </span>
          <div className="field">
            <label>admin token</label>
            <input
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              onBlur={() => setToken(tokenInput.trim() || "dev-token")}
              spellCheck={false}
            />
          </div>
          <button
            className="btn ghost"
            type="button"
            onClick={() => {
              setToken(tokenInput.trim() || "dev-token");
              setTick((t) => t + 1);
            }}
          >
            刷新
          </button>
        </div>
      </header>

      <section className="stats">
        <div className="stat">
          <div className="label">Apps</div>
          <div className="value">{counts.apps}</div>
        </div>
        <div className="stat">
          <div className="label">Online instances</div>
          <div className="value">{counts.instances}</div>
        </div>
        <div className="stat">
          <div className="label">Events window</div>
          <div className="value">{counts.events}</div>
        </div>
        <div className="stat">
          <div className="label">User remarks</div>
          <div className="value">{counts.remarks}</div>
        </div>
        <div className="stat">
          <div className="label">User tags</div>
          <div className="value">{counts.tags}</div>
        </div>
      </section>

      <section className="panel">
        <div className="tabs">
          {(
            [
              ["events", "事件"],
              ["http", "HTTP 请求"],
              ["instances", "在线实例"],
              ["remarks", "用户备注/标签"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`tab ${tab === id ? "active" : ""}`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "events" && (
          <div className="toolbar">
            <div className="field">
              <label>user_id</label>
              <input
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                placeholder="过滤用户"
              />
            </div>
            <div className="field">
              <label>event_type</label>
              <input
                value={eventType}
                onChange={(e) => setEventType(e.target.value)}
                placeholder="im.message.receive_v1"
              />
            </div>
            <div className="mono" style={{ color: "var(--muted)" }}>
              acked {counts.acked} · failed/dropped {counts.failed}
            </div>
          </div>
        )}

        {tab === "http" && (
          <div className="toolbar">
            <div className="field">
              <label>path contains</label>
              <input
                value={pathFilter}
                onChange={(e) => setPathFilter(e.target.value)}
                placeholder="/open-apis/"
              />
            </div>
          </div>
        )}

        {tab === "remarks" && (
          <div className="toolbar remark-form">
            <div className="field grow">
              <label>user_id</label>
              <input
                value={remarkDraft.userId}
                onChange={(e) =>
                  setRemarkDraft((d) => ({ ...d, userId: e.target.value }))
                }
                placeholder="ou_ / on_ / 任意用户 ID"
                spellCheck={false}
              />
            </div>
            <div className="field">
              <label>标签</label>
              <select
                value={remarkDraft.tag}
                onChange={(e) =>
                  setRemarkDraft((d) => ({
                    ...d,
                    tag: e.target.value as UserTag,
                  }))
                }
              >
                {USER_TAG_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field grow">
              <label>备注名称（可选）</label>
              <input
                value={remarkDraft.remark}
                onChange={(e) =>
                  setRemarkDraft((d) => ({ ...d, remark: e.target.value }))
                }
                placeholder="例如：张三 / 测试账号"
                maxLength={64}
              />
            </div>
            <button
              className="btn"
              type="button"
              disabled={remarkBusy}
              onClick={() => void saveRemark()}
            >
              保存
            </button>
          </div>
        )}

        {error ? (
          <div className="error">{error}</div>
        ) : tab === "events" ? (
          <EventsTable
            rows={events}
            remarks={remarkMap}
            tags={tagMap}
            expanded={expanded}
            onToggle={(id) => setExpanded((cur) => (cur === id ? null : id))}
            onEditRemark={openRemarkEditor}
          />
        ) : tab === "http" ? (
          <HttpTable
            rows={httpRows}
            expanded={expanded}
            onToggle={(id) => setExpanded((cur) => (cur === id ? null : id))}
          />
        ) : tab === "instances" ? (
          <InstancesTable
            health={health}
            busyId={signalBusyId}
            onOffline={(row, signal) => void offlineInstance(row, signal)}
          />
        ) : (
          <RemarksTable
            remarks={remarks}
            tags={tags}
            busy={remarkBusy}
            onEdit={(userId) => openRemarkEditor(userId)}
            onDeleteRemark={(id) => void removeRemark(id)}
            onDeleteTag={(id) => void removeTag(id)}
          />
        )}
      </section>
    </div>
  );
}

function EventsTable({
  rows,
  remarks,
  tags,
  expanded,
  onToggle,
  onEditRemark,
}: {
  rows: EventRow[];
  remarks: Record<string, string>;
  tags: Record<string, UserTag>;
  expanded: string | null;
  onToggle: (id: string) => void;
  onEditRemark: (userId: string) => void;
}) {
  if (rows.length === 0) return <div className="empty">暂无事件</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>时间</th>
            <th>状态</th>
            <th>类型</th>
            <th>用户</th>
            <th>实例</th>
            <th>trace</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const uid = resolveUserId(row);
            return (
              <tr key={row.trace_id} onClick={() => onToggle(row.trace_id)}>
                <td className="mono">{fmtTime(row.received_at)}</td>
                <td>
                  <StatusPill status={row.status} />
                  {expanded === row.trace_id && (
                    <div className="detail">
                      {row.error ? `error: ${row.error}\n` : ""}
                      {truncate(row.payload, 600)}
                    </div>
                  )}
                </td>
                <td className="mono">{row.event_type ?? "—"}</td>
                <td>
                  <UserLabel
                    userId={uid}
                    remarks={remarks}
                    tags={tags}
                    onEdit={onEditRemark}
                  />
                </td>
                <td className="mono">{row.instance_id?.slice(0, 8) ?? "—"}</td>
                <td className="mono">{row.trace_id.slice(0, 8)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function HttpTable({
  rows,
  expanded,
  onToggle,
}: {
  rows: HttpRow[];
  expanded: string | null;
  onToggle: (id: string) => void;
}) {
  if (rows.length === 0) return <div className="empty">暂无 HTTP 记录</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>时间</th>
            <th>状态</th>
            <th>方法</th>
            <th>路径</th>
            <th>耗时</th>
            <th>app</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.trace_id} onClick={() => onToggle(row.trace_id)}>
              <td className="mono">{fmtTime(row.created_at)}</td>
              <td>
                <span
                  className={`pill ${row.status_code < 400 ? "ok" : "err"}`}
                >
                  {row.status_code}
                </span>
                {expanded === row.trace_id && (
                  <div className="detail">
                    req: {truncate(row.request_snippet, 400)}
                    {"\n"}
                    res: {truncate(row.response_snippet, 400)}
                  </div>
                )}
              </td>
              <td className="mono">{row.method}</td>
              <td className="mono">{row.path}</td>
              <td className="mono">{Math.round(row.duration_ms)}ms</td>
              <td className="mono">{row.app_id ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InstancesTable({
  health,
  busyId,
  onOffline,
}: {
  health: Health | null;
  busyId: string | null;
  onOffline: (row: InstanceRow, signal: AgentSignal) => void;
}) {
  const rows = health?.instances ?? [];
  if (rows.length === 0) return <div className="empty">暂无在线实例</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>App</th>
            <th>Instance</th>
            <th>Env</th>
            <th>状态</th>
            <th>Connected</th>
            <th>Heartbeat</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const busy = busyId === row.instanceId;
            return (
              <tr key={row.instanceId}>
                <td className="mono">{row.appId}</td>
                <td className="mono">{row.instanceId}</td>
                <td>
                  <span className={`pill env-${row.env}`}>{row.env}</span>
                </td>
                <td>
                  {row.draining ? (
                    <span className="pill pending">draining</span>
                  ) : (
                    <span className="pill ok">online</span>
                  )}
                </td>
                <td className="mono">
                  {fmtTime(new Date(row.connectedAt).toISOString())}
                </td>
                <td className="mono">
                  {fmtTime(new Date(row.lastHeartbeatAt).toISOString())}
                </td>
                <td>
                  <div className="row-actions">
                    <button
                      type="button"
                      className="btn ghost compact"
                      disabled={busy || !!busyId || !!row.draining}
                      title="优雅下线：停分流，等 Agent 完成 in-flight 后退出"
                      onClick={() => onOffline(row, "graceful")}
                    >
                      {busy ? "下线中…" : "优雅下线"}
                    </button>
                    <button
                      type="button"
                      className="btn ghost compact danger-text"
                      disabled={busy || !!busyId}
                      title="强制下线：立即掐断 WS"
                      onClick={() => onOffline(row, "force")}
                    >
                      强制下线
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RemarksTable({
  remarks,
  tags,
  busy,
  onEdit,
  onDeleteRemark,
  onDeleteTag,
}: {
  remarks: UserRemarkRow[];
  tags: UserTagRow[];
  busy: boolean;
  onEdit: (userId: string) => void;
  onDeleteRemark: (userId: string) => void;
  onDeleteTag: (userId: string) => void;
}) {
  const remarkMap = useMemo(() => {
    const map: Record<string, UserRemarkRow> = {};
    for (const row of remarks) map[row.user_id] = row;
    return map;
  }, [remarks]);
  const tagMap = useMemo(() => {
    const map: Record<string, UserTagRow> = {};
    for (const row of tags) map[row.user_id] = row;
    return map;
  }, [tags]);

  const userIds = useMemo(() => {
    const set = new Set<string>();
    for (const row of remarks) set.add(row.user_id);
    for (const row of tags) set.add(row.user_id);
    return [...set].sort((a, b) => {
      const ta = tagMap[a]?.updated_at ?? remarkMap[a]?.updated_at ?? "";
      const tb = tagMap[b]?.updated_at ?? remarkMap[b]?.updated_at ?? "";
      return tb.localeCompare(ta);
    });
  }, [remarks, tags, remarkMap, tagMap]);

  if (userIds.length === 0) {
    return (
      <div className="empty">
        暂无备注/标签。可在上方填写，或从事件列表点击用户 ID。未打标默认按普通用户（prod）分流。
      </div>
    );
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>标签</th>
            <th>备注名称</th>
            <th>user_id</th>
            <th>更新时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {userIds.map((id) => {
            const remark = remarkMap[id];
            const tag = tagMap[id];
            const updated = tag?.updated_at ?? remark?.updated_at;
            return (
              <tr key={id}>
                <td>
                  <span className={`pill tag-${tag?.tag ?? "user"}`}>
                    {userTagLabel(tag?.tag ?? "user")}
                  </span>
                </td>
                <td>
                  {remark ? (
                    <span className="user-remark">{remark.remark}</span>
                  ) : (
                    <span className="mono">—</span>
                  )}
                </td>
                <td className="mono">{id}</td>
                <td className="mono">{fmtTime(updated)}</td>
                <td>
                  <div className="row-actions">
                    <button
                      type="button"
                      className="btn ghost compact"
                      disabled={busy}
                      onClick={() => onEdit(id)}
                    >
                      编辑
                    </button>
                    {remark ? (
                      <button
                        type="button"
                        className="btn ghost compact danger-text"
                        disabled={busy}
                        onClick={() => onDeleteRemark(id)}
                      >
                        删备注
                      </button>
                    ) : null}
                    {tag ? (
                      <button
                        type="button"
                        className="btn ghost compact danger-text"
                        disabled={busy}
                        onClick={() => onDeleteTag(id)}
                      >
                        删标签
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
