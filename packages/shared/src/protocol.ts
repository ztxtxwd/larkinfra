import protobuf from "protobufjs";

export enum FrameType {
  control = 0,
  data = 1,
}

export enum MessageType {
  event = "event",
  card = "card",
  ping = "ping",
  pong = "pong",
}

export enum HeaderKey {
  type = "type",
  message_id = "message_id",
  sum = "sum",
  seq = "seq",
  trace_id = "trace_id",
  biz_rt = "biz_rt",
  handshake_status = "handshake-status",
  handshake_msg = "handshake-msg",
  handshake_autherrcode = "handshake-autherrcode",
}

export interface FrameHeader {
  key: string;
  value: string;
}

export interface FrameMessage {
  SeqID: number;
  LogID: number;
  service: number;
  method: number;
  headers: FrameHeader[];
  payloadEncoding?: string;
  payloadType?: string;
  payload?: Uint8Array;
  LogIDNew?: string;
}

const PROTO = `
syntax = "proto2";
package pbbp2;

message Header {
  required string key = 1;
  required string value = 2;
}

message Frame {
  required uint64 SeqID = 1;
  required uint64 LogID = 2;
  required int32 service = 3;
  required int32 method = 4;
  repeated Header headers = 5;
  optional string payloadEncoding = 6;
  optional string payloadType = 7;
  optional bytes payload = 8;
  optional string LogIDNew = 9;
}
`;

const root = protobuf.parse(PROTO, { keepCase: true }).root;
const Frame = root.lookupType("pbbp2.Frame");

export function encodeFrame(frame: FrameMessage): Uint8Array {
  const err = Frame.verify(frame);
  if (err) throw new Error(`invalid frame: ${err}`);
  const message = Frame.create(frame);
  return Frame.encode(message).finish();
}

export function decodeFrame(buffer: Uint8Array): FrameMessage {
  const decoded = Frame.decode(buffer) as unknown as FrameMessage;
  return {
    SeqID: Number(decoded.SeqID ?? 0),
    LogID: Number(decoded.LogID ?? 0),
    service: Number(decoded.service ?? 0),
    method: Number(decoded.method ?? 0),
    headers: (decoded.headers ?? []).map((h) => ({
      key: String(h.key),
      value: String(h.value),
    })),
    payloadEncoding: decoded.payloadEncoding || undefined,
    payloadType: decoded.payloadType || undefined,
    payload: decoded.payload
      ? Uint8Array.from(decoded.payload as Uint8Array)
      : new Uint8Array(),
    LogIDNew: decoded.LogIDNew || undefined,
  };
}

export function headerMap(headers: FrameHeader[]): Record<string, string> {
  return headers.reduce<Record<string, string>>((acc, cur) => {
    acc[cur.key] = cur.value;
    return acc;
  }, {});
}

export function getHeader(
  headers: FrameHeader[],
  key: string,
): string | undefined {
  return headers.find((h) => h.key === key)?.value;
}

export function buildPingFrame(serviceId: number): FrameMessage {
  return {
    SeqID: 0,
    LogID: 0,
    service: serviceId,
    method: FrameType.control,
    headers: [{ key: HeaderKey.type, value: MessageType.ping }],
  };
}

export function buildPongFrame(
  serviceId: number,
  config: {
    PingInterval: number;
    ReconnectCount: number;
    ReconnectInterval: number;
    ReconnectNonce: number;
  },
): FrameMessage {
  return {
    SeqID: 0,
    LogID: 0,
    service: serviceId,
    method: FrameType.control,
    headers: [{ key: HeaderKey.type, value: MessageType.pong }],
    payload: new TextEncoder().encode(JSON.stringify(config)),
  };
}

export function buildEventFrame(params: {
  serviceId: number;
  messageId: string;
  traceId: string;
  payload: unknown;
  seqId?: number;
  logId?: number;
}): FrameMessage {
  const body = new TextEncoder().encode(JSON.stringify(params.payload));
  return {
    SeqID: params.seqId ?? Date.now(),
    LogID: params.logId ?? Date.now(),
    service: params.serviceId,
    method: FrameType.data,
    headers: [
      { key: HeaderKey.type, value: MessageType.event },
      { key: HeaderKey.message_id, value: params.messageId },
      { key: HeaderKey.sum, value: "1" },
      { key: HeaderKey.seq, value: "0" },
      { key: HeaderKey.trace_id, value: params.traceId },
    ],
    payloadEncoding: "json",
    payloadType: "event",
    payload: body,
  };
}
