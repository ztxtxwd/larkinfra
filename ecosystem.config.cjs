/**
 * PM2 本地部署：仅网关
 *
 * 使用前先构建：
 *   pnpm --filter @larkinfra/shared build
 *   pnpm --filter @larkinfra/web build
 *   pnpm --filter @larkinfra/gateway build
 *
 * 启动：
 *   pm2 start ecosystem.config.cjs
 *   pm2 logs
 *   pm2 stop ecosystem.config.cjs
 *
 * 示例 Agent 请本地另开终端跑，不要用 PM2：
 *   INSTANCE_NAME=agent-a pnpm --filter @larkinfra/echo-agent start
 */
const path = require("node:path");

const root = __dirname;

module.exports = {
  apps: [
    {
      name: "larkinfra-gateway",
      cwd: root,
      script: "packages/gateway/dist/index.js",
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 20,
      min_uptime: "5s",
      kill_timeout: 8000,
      env: {
        NODE_ENV: "production",
        LARKINFRA_CONFIG: path.join(root, "config.yaml"),
      },
      error_file: path.join(root, "logs", "gateway-error.log"),
      out_file: path.join(root, "logs", "gateway-out.log"),
      merge_logs: true,
      time: true,
    },
  ],
};
