#!/usr/bin/env bash
# 本地编译，把产物发到远程主机并用 PM2 启动网关。
#
# 用法：
#   pnpm deploy:remote
#   DEPLOY_HOST=user@host DEPLOY_DIR='~/apps/larkinfra' bash scripts/deploy.sh
#
# 远程只执行 `pnpm install --prod`（DuckDB 等原生模块须按远程平台安装）。
# 远程已有的 config.yaml / data / logs 会保留；首次部署从 config.example.yaml
# 生成 config.yaml 并随机生成 admin token。上一版保留在 <DEPLOY_DIR>.prev 便于回滚。
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-user@liwork}"
DEPLOY_DIR="${DEPLOY_DIR:-~/code/larkinfra}"
SKIP_BUILD="${SKIP_BUILD:-0}"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

if [ "$SKIP_BUILD" != "1" ]; then
  echo "==> 本地构建"
  pnpm pm2:build
fi

tarball="$(mktemp -t larkinfra-dist.XXXXXX).tgz"
trap 'rm -f "$tarball"' EXIT

echo "==> 打包产物"
tar czf "$tarball" \
  package.json pnpm-lock.yaml pnpm-workspace.yaml \
  ecosystem.config.cjs config.example.yaml \
  packages/*/package.json packages/*/dist \
  examples/*/package.json

remote_tar="/tmp/larkinfra-dist-$$.tgz"
echo "==> 上传到 $DEPLOY_HOST"
scp -q "$tarball" "$DEPLOY_HOST:$remote_tar"

echo "==> 远程安装并重启"
ssh "$DEPLOY_HOST" "DEPLOY_DIR=$DEPLOY_DIR REMOTE_TAR=$remote_tar bash -s" <<'REMOTE'
set -euo pipefail
# 远程 Node 默认不信任系统 CA，pnpm/corepack 下载会失败
export NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-/etc/ssl/certs/ca-certificates.crt}"

dir="${DEPLOY_DIR/#\~/$HOME}"
next="$dir.next"
prev="$dir.prev"

rm -rf "$next" && mkdir -p "$next"
tar xzf "$REMOTE_TAR" -C "$next"
rm -f "$REMOTE_TAR"

if [ -f "$dir/config.yaml" ]; then
  cp "$dir/config.yaml" "$next/config.yaml"
else
  cp "$next/config.example.yaml" "$next/config.yaml"
  token="$(openssl rand -hex 16)"
  sed -i "s/token: \"dev-token\"/token: \"$token\"/" "$next/config.yaml"
  echo "首次部署：已生成 admin token $token"
fi

(cd "$next" && pnpm install --prod --frozen-lockfile --reporter=silent)

# 切换目录：data / logs 跟随迁移
for d in data logs; do
  if [ -d "$dir/$d" ]; then mv "$dir/$d" "$next/$d"; else mkdir -p "$next/$d"; fi
done
if [ -d "$dir" ]; then rm -rf "$prev" && mv "$dir" "$prev"; fi
mv "$next" "$dir"

cd "$dir"
pm2 startOrReload ecosystem.config.cjs --update-env >/dev/null
pm2 save >/dev/null

port="$(sed -n 's/^listen: *"\{0,1\}[^:]*:\([0-9]*\).*/\1/p' config.yaml)"
for _ in $(seq 1 15); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${port:-18787}/ui/" 2>/dev/null; then
    pm2 ls | grep larkinfra-gateway
    echo "部署完成：http://127.0.0.1:${port:-18787}/ui/"
    exit 0
  fi
  sleep 1
done
echo "网关未就绪，最近日志：" >&2
tail -20 logs/gateway-out.log logs/gateway-error.log >&2 || true
exit 1
REMOTE
