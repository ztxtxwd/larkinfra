# echo-agent — 生命周期信号（网关下发）

网关通过 **下游 WebSocket 事件通道** 向 Agent 推送生命周期指令。  
这不是 OS 的 `SIGTERM`/`SIGINT`，只是借用「温和 / 强硬」两种语义：

| `signal` | 事件类型 (`header.event_type`) | 含义 |
|----------|--------------------------------|------|
| `graceful` | `larkinfra.signal.graceful` | **优雅退出**：先停收新流量，业务做完 in-flight 再关连接退出 |
| `force` | `larkinfra.signal.force` | **强制退出**：立即退出，不等待 drain；网关也会掐断 WS |

## Zero-loss 滚动更新流程

```
编排器 / 运维                 Gateway                      Agent (旧实例)
   │                            │                              │
   │  新实例已上线               │                              │
   │  POST .../signal           │                              │
   │  { signal: "graceful" }    │                              │
   │ ──────────────────────────►│ mark draining                │
   │                            │ (路由立即剔除该实例)           │
   │                            │ WS event: graceful ─────────►│
   │                            │◄──────── ACK ────────────────│
   │                            │ 新事件只打到剩余实例            │  drain in-flight
   │                            │◄──────── WS close ───────────│  然后退出
```

关键：发信号前网关会把实例标为 `draining`，`listRoutableIds` 不再包含它，因此 **不会丢已在途任务，也不会再把新事件打到正在下线的实例**。

## 网关怎么发

```bash
# 查实例
curl -s -H "x-admin-token: dev-token" \
  http://127.0.0.1:18787/admin/apps/<appId>/instances

# 优雅下线（推荐滚动更新）
curl -s -X POST -H "x-admin-token: dev-token" -H "content-type: application/json" \
  http://127.0.0.1:18787/admin/apps/<appId>/instances/<instanceId>/signal \
  -d '{"signal":"graceful","reason":"rolling_update","waitOfflineMs":3600000}'

# 强制下线
curl -s -X POST -H "x-admin-token: dev-token" -H "content-type: application/json" \
  http://127.0.0.1:18787/admin/apps/<appId>/instances/<instanceId>/signal \
  -d '{"signal":"force","reason":"stuck"}'
```

| 字段 | 说明 |
|------|------|
| `signal` | `graceful` \| `force` |
| `reason` | 可选，透传给业务 |
| `waitOfflineMs` | 仅 `graceful`：>0 时阻塞等到 WS 断开或超时 |

## 业务侧怎么接（官方 SDK）

```ts
import { SIGNAL_EVENT_TYPES } from "@larkinfra/shared";
import * as Lark from "@larksuiteoapi/node-sdk";

wsClient.start({
  eventDispatcher: new Lark.EventDispatcher({}).register({
    [SIGNAL_EVENT_TYPES.graceful]: async (data) => {
      // 必须快返回以便 ACK；drain 放到后台
      void gracefulShutdown(data.reason);
    },
    [SIGNAL_EVENT_TYPES.force]: async () => {
      setTimeout(() => forceShutdown(), 0);
    },
    // ...业务事件
  }),
});
```

本示例的行为：

- `graceful`：等 in-flight 结束（默认最多 3600s，`SHUTDOWN_DRAIN_MS`），再 `wsClient.close()` 退出
- `force`：跳过 drain，强制关 WS 并 `exit(1)`

## 本地自测

```bash
# 终端 1
pnpm --filter @larkinfra/gateway dev

# 终端 2
INSTANCE_NAME=agent-a pnpm --filter @larkinfra/echo-agent start

# 终端 3
APP=cli_...   # .env 里的 LARK_APP_ID（Agent 接入后自动注册）
ID=$(curl -s -H "x-admin-token: dev-token" \
  http://127.0.0.1:18787/admin/apps/$APP/instances | jq -r '.instances[0].instanceId')

curl -s -X POST -H "x-admin-token: dev-token" -H "content-type: application/json" \
  http://127.0.0.1:18787/admin/apps/$APP/instances/$ID/signal \
  -d '{"signal":"graceful","waitOfflineMs":10000}'
```
