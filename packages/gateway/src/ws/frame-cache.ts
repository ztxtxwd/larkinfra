import type { FrameMessage } from "@larkinfra/shared";

interface CacheEntry {
  buffer: (Uint8Array | undefined)[];
  createdAt: number;
}

/** Merge fragmented Feishu WS event payloads (sum/seq). */
export class FrameDataCache {
  private cache = new Map<string, CacheEntry>();

  constructor(private ttlMs = 10_000) {}

  merge(params: {
    messageId: string;
    sum: number;
    seq: number;
    data: Uint8Array;
  }): Uint8Array | null {
    const { messageId, sum, seq, data } = params;
    let entry = this.cache.get(messageId);
    if (!entry) {
      entry = {
        buffer: new Array(sum).fill(undefined),
        createdAt: Date.now(),
      };
      this.cache.set(messageId, entry);
    }
    entry.buffer[seq] = data;
    if (!entry.buffer.every((item) => !!item)) return null;

    const merged = entry.buffer.reduce((acc, cur) => {
      const part = cur!;
      const combined = new Uint8Array(acc.byteLength + part.byteLength);
      combined.set(acc, 0);
      combined.set(part, acc.byteLength);
      return combined;
    }, new Uint8Array());
    this.cache.delete(messageId);
    return merged;
  }

  sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.createdAt > this.ttlMs) this.cache.delete(key);
    }
  }
}

export function payloadFromFrame(
  cache: FrameDataCache,
  frame: FrameMessage,
): unknown | null {
  const headers = Object.fromEntries(frame.headers.map((h) => [h.key, h.value]));
  const messageId = headers.message_id;
  if (!messageId || !frame.payload) return null;
  const merged = cache.merge({
    messageId,
    sum: Number(headers.sum ?? 1),
    seq: Number(headers.seq ?? 0),
    data: frame.payload,
  });
  if (!merged) return null;
  const text = new TextDecoder("utf-8").decode(merged);
  return JSON.parse(text) as unknown;
}
