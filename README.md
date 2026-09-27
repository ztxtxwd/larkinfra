# LarkInfra — 飞书 Agent 透明网关

单机 MVP：用官方 `@larksuiteoapi/node-sdk`，**只改 `domain`** 即可接入。

- **HTTP 出站**：`/open-apis/**` 透明反代到 `open.feishu.cn`，全量写入 DuckDB
- **WS 进站**：网关独占上游飞书长连接；Agent 多实例连网关，按 `user_id` consistent hash 分流
- **注册发现**：Agent 用官方 `WSClient` 建连即上线，断线/心跳超时自动剔除

## 架构

```
飞书 Frontier WS ──► Gateway ──► Agent 实例（官方 SDK）
                       │
Agent HTTP ────────────┼──► open.feishu.cn
                       │
                    DuckDB 追踪
```

## 快速开始

```bash
pnpm install
cp config.example.yaml config.yaml
cp .env.example .env
# 编辑 .env：填入业务侧 LARK_APP_ID / LARK_APP_SECRET（Agent 接入时自动注册到网关）

pnpm --filter @larkinfra/shared build
pnpm --filter @larkinfra/web build
pnpm --filter @larkinfra/gateway dev
```

浏览器打开可视化控制台：

- 同端口：`http://127.0.0.1:18787/ui/`（admin token 默认 `dev-token`）
- 或独立开发：`pnpm --filter @larkinfra/web dev` → `http://127.0.0.1:5173/ui/`

另开终端跑 Agent（读 `.env` 中的凭证，连接网关时自动完成应用注册）：

```bash
INSTANCE_NAME=agent-a pnpm --filter @larkinfra/echo-agent start
INSTANCE_NAME=agent-b pnpm --filter @larkinfra/echo-agent start
```

滚动更新时由网关经 WS 下发 `graceful` / `force` 生命周期信号（见 [`examples/echo-agent/README.md`](examples/echo-agent/README.md)）。

也可用环境变量：`LARK_APP_ID` / `LARK_APP_SECRET` / `LARK_DOMAIN`。网关 `appDefaults.env` 控制自动注册应用的默认环境（`dev` | `test` | `staging` | `prod`）；实例上线后继承该值。可选在 `config.yaml` 的 `apps[]` 做启动引导，一般不需要。

飞书开发者后台将该企业自建应用的事件订阅设为「使用长连接接收事件」，并确保网关进程在线。

## PM2 本地部署

需已安装 [pm2](https://pm2.keymetrics.io/)，并配置好仓库根目录的 `config.yaml` / `.env`。PM2 **只跑网关**；示例 Agent 用上面的 `pnpm --filter @larkinfra/echo-agent start` 另开终端即可。

```bash
# 构建并启动网关
pnpm pm2:start

# 查看状态 / 日志
pm2 status
pm2 logs larkinfra-gateway

# 热重载（先重新 build）
pnpm pm2:reload

# 停止 / 删除进程
pnpm pm2:stop
pnpm pm2:delete
```

控制台：`http://127.0.0.1:18787/ui/`（admin token 默认 `dev-token`）。进程定义见 [`ecosystem.config.cjs`](ecosystem.config.cjs)。

## 应用注册

网关**不再要求**集中预配业务 `appId` / `appSecret`。流程：

1. Agent 用官方 `WSClient` 指向网关 `domain`，携带自身飞书凭证
2. SDK 调用网关 `/callback/ws/endpoint`
3. 网关校验：未见过则注册，已见过则核对 secret
4. 按 `appDefaults.upstreamConnections` 拉起对该应用的飞书上游长连接
5. 下发下游 WS URL，Agent 实例上线

同一 `appId` 后续实例复用已注册凭证；secret 不匹配则拒绝。
## 客户端用法

```ts
import * as Lark from "@larksuiteoapi/node-sdk";

const domain = "http://127.0.0.1:18787";
const client = new Lark.Client({ appId, appSecret, domain });
const wsClient = new Lark.WSClient({ appId, appSecret, domain });
```

## 管理接口

请求头：`x-admin-token: <admin.token>`

| 路径 | 说明 |
|------|------|
| `GET /admin/health` | 健康检查 + 在线实例 |
| `GET /admin/apps/:appId/instances` | 某应用在线实例 |
| `POST /admin/apps/:appId/instances/:instanceId/signal` | 下发 `graceful`/`force` 生命周期信号（滚动更新） |
| `GET /admin/traces/events?user_id=&event_type=` | 事件追踪 |
| `GET /admin/traces/http?path=` | HTTP 请求追踪 |
| `GET /admin/users/remarks` | 用户备注列表 |
| `PUT /admin/users/:userId/remark` | 设置备注（body: `{remark}`，最长 64） |
| `DELETE /admin/users/:userId/remark` | 删除备注 |
| `GET /admin/users/tags` | 用户标签列表（developer / tester / user） |
| `PUT /admin/users/:userId/tag` | 设置标签（body: `{tag}`） |
| `DELETE /admin/users/:userId/tag` | 删除标签（删除后按普通用户处理） |
| `POST /admin/inject-event` | 本地注入事件（测分流，body: `{appId, payload}`） |

## 分流说明

同一 `user_id` 会稳定路由到同一在线实例；实例下线后自动重新哈希到剩余实例。无在线实例时事件记为 `dropped`，并向飞书返回失败 ACK（避免长时间占住 3s 窗口）。

用户标签表示环境**倾向**（未打标视为普通用户），按阶梯向上回落选池后再哈希：

| 标签 | 回落链 |
|------|--------|
| 开发者 `developer` | `dev` → `test` → `staging` → `prod` |
| 测试者 `tester` | `test` → `staging` → `prod` |
| 普通用户 `user`（含未打标） | `prod` |

> 官方 Node SDK 会校验 `appId` 格式为 `cli_` + 16 位十六进制，否则 `WSClient.start` 会直接拒绝。

## 包结构

- `packages/shared` — 配置 schema、路由键、pbbp2 帧编解码
- `packages/gateway` — HTTP/WS 网关主进程
- `packages/web` — 事件/请求可视化控制台（`/ui/`）
- `examples/echo-agent` — 官方 SDK 示例 Agent
