import { randomUUID } from "node:crypto";

/**
 * Gateway → Agent lifecycle commands over the Feishu-compatible WS event channel.
 * Not OS signals — names describe intended agent behavior:
 * - graceful: stop taking new work, finish in-flight, then exit
 * - force: exit immediately (skip drain)
 */
export type AgentSignal = "graceful" | "force";

/** EventDispatcher keys for `@larksuiteoapi/node-sdk`. */
export const SIGNAL_EVENT_TYPES = {
  graceful: "larkinfra.signal.graceful",
  force: "larkinfra.signal.force",
} as const satisfies Record<AgentSignal, string>;

export function isAgentSignal(value: string): value is AgentSignal {
  return value === "graceful" || value === "force";
}

export function signalEventType(signal: AgentSignal): string {
  return SIGNAL_EVENT_TYPES[signal];
}

/**
 * Feishu schema-2.0 event so WSClient → EventDispatcher routes via
 * `header.event_type`.
 */
export function buildSignalEventPayload(params: {
  signal: AgentSignal;
  appId: string;
  instanceId: string;
  reason?: string;
}): {
  schema: string;
  header: {
    event_id: string;
    token: string;
    create_time: string;
    event_type: string;
    tenant_key: string;
    app_id: string;
  };
  event: {
    signal: AgentSignal;
    instance_id: string;
    reason: string;
  };
} {
  return {
    schema: "2.0",
    header: {
      event_id: randomUUID(),
      token: "",
      create_time: String(Date.now()),
      event_type: SIGNAL_EVENT_TYPES[params.signal],
      tenant_key: "",
      app_id: params.appId,
    },
    event: {
      signal: params.signal,
      instance_id: params.instanceId,
      reason: params.reason ?? "drain",
    },
  };
}
