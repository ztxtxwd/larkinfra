import type { WebSocket } from "ws";
import {
  preferEnvChain,
  type AppEnv,
  type UserTag,
} from "@larkinfra/shared";

export interface AgentInstance {
  instanceId: string;
  appId: string;
  serviceId: number;
  /** Feishu application environment this instance is serving. */
  env: AppEnv;
  socket: WebSocket;
  connectedAt: number;
  lastHeartbeatAt: number;
  /** Excluded from routing; waiting for agent to finish and disconnect. */
  draining: boolean;
  tags?: string[];
}

export class InstanceRegistry {
  private byApp = new Map<string, Map<string, AgentInstance>>();
  private bySocket = new Map<WebSocket, AgentInstance>();
  private offlineWaiters = new Map<
    string,
    Set<{ resolve: () => void; timer: NodeJS.Timeout }>
  >();

  private waiterKey(appId: string, instanceId: string): string {
    return `${appId}::${instanceId}`;
  }

  register(instance: Omit<AgentInstance, "draining"> & { draining?: boolean }): void {
    const full: AgentInstance = {
      ...instance,
      draining: instance.draining ?? false,
    };
    let appMap = this.byApp.get(full.appId);
    if (!appMap) {
      appMap = new Map();
      this.byApp.set(full.appId, appMap);
    }
    appMap.set(full.instanceId, full);
    this.bySocket.set(full.socket, full);
  }

  unregister(socket: WebSocket): AgentInstance | undefined {
    const instance = this.bySocket.get(socket);
    if (!instance) return undefined;
    this.bySocket.delete(socket);
    const appMap = this.byApp.get(instance.appId);
    appMap?.delete(instance.instanceId);
    if (appMap && appMap.size === 0) this.byApp.delete(instance.appId);
    this.notifyOffline(instance.appId, instance.instanceId);
    return instance;
  }

  private notifyOffline(appId: string, instanceId: string): void {
    const key = this.waiterKey(appId, instanceId);
    const waiters = this.offlineWaiters.get(key);
    if (!waiters) return;
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.resolve();
    }
    this.offlineWaiters.delete(key);
  }

  touch(socket: WebSocket): void {
    const instance = this.bySocket.get(socket);
    if (instance) instance.lastHeartbeatAt = Date.now();
  }

  get(appId: string, instanceId: string): AgentInstance | undefined {
    return this.byApp.get(appId)?.get(instanceId);
  }

  markDraining(appId: string, instanceId: string): AgentInstance | undefined {
    const instance = this.get(appId, instanceId);
    if (!instance) return undefined;
    instance.draining = true;
    return instance;
  }

  setEnv(
    appId: string,
    instanceId: string,
    env: AppEnv,
  ): AgentInstance | undefined {
    const instance = this.get(appId, instanceId);
    if (!instance) return undefined;
    instance.env = env;
    return instance;
  }

  findByInstanceId(instanceId: string): AgentInstance | undefined {
    for (const instance of this.bySocket.values()) {
      if (instance.instanceId === instanceId) return instance;
    }
    return undefined;
  }

  list(appId: string): AgentInstance[] {
    return [...(this.byApp.get(appId)?.values() ?? [])];
  }

  /** All connected instance ids (includes draining). */
  listIds(appId: string): string[] {
    return this.list(appId).map((i) => i.instanceId);
  }

  /** Instance ids eligible for event routing (excludes draining). */
  listRoutableIds(appId: string, env?: AppEnv): string[] {
    return this.list(appId)
      .filter((i) => !i.draining && (env === undefined || i.env === env))
      .map((i) => i.instanceId);
  }

  /**
   * Resolve routable instance ids for a user tag preference chain.
   * Walks env ladder (e.g. developer: dev→test→staging→prod) and returns
   * the first non-empty pool. Missing tag is treated as ordinary user.
   */
  listRoutableIdsForTag(
    appId: string,
    tag?: UserTag | string | null,
  ): { instanceIds: string[]; env?: AppEnv } {
    for (const env of preferEnvChain(tag)) {
      const instanceIds = this.listRoutableIds(appId, env);
      if (instanceIds.length > 0) return { instanceIds, env };
    }
    return { instanceIds: [] };
  }

  listAll(): AgentInstance[] {
    return [...this.bySocket.values()];
  }

  /**
   * Resolves when the instance disconnects, or after timeout.
   * If already gone, resolves immediately with `"offline"`.
   */
  waitUntilOffline(
    appId: string,
    instanceId: string,
    timeoutMs: number,
  ): Promise<"offline" | "timeout"> {
    if (!this.get(appId, instanceId)) return Promise.resolve("offline");

    return new Promise((resolve) => {
      const key = this.waiterKey(appId, instanceId);
      let waiters = this.offlineWaiters.get(key);
      if (!waiters) {
        waiters = new Set();
        this.offlineWaiters.set(key, waiters);
      }

      const entry = {
        resolve: () => {
          waiters!.delete(entry);
          if (waiters!.size === 0) this.offlineWaiters.delete(key);
          resolve("offline");
        },
        timer: setTimeout(() => {
          waiters!.delete(entry);
          if (waiters!.size === 0) this.offlineWaiters.delete(key);
          resolve("timeout");
        }, timeoutMs),
      };
      waiters.add(entry);
    });
  }

  sweepExpired(ttlMs: number): AgentInstance[] {
    const now = Date.now();
    const expired: AgentInstance[] = [];
    for (const instance of this.bySocket.values()) {
      if (now - instance.lastHeartbeatAt > ttlMs) {
        expired.push(instance);
      }
    }
    for (const instance of expired) {
      try {
        instance.socket.terminate();
      } catch {
        // ignore
      }
      this.unregister(instance.socket);
    }
    return expired;
  }
}
