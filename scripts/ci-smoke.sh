#!/usr/bin/env bash
# build-pool 冒烟门（pool 的 image.yml 优先跑仓内 scripts/ci-smoke.sh，覆盖 SMOKE_*）。
# 对 fd-strapi：dummy 密钥 + 默认 sqlite 起容器，wget 探 /_health（alpine 无 curl），
# 24×5s 内不通或容器退出即失败。生产 Postgres/真实密钥由部署侧 compose 提供，
# 这里只验「镜像能起、能应答」。
set -e
IMG="$1"
NAME=fd-strapi-pool-smoke
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" \
  -e HOST=0.0.0.0 -e PORT=1337 \
  -e APP_KEYS=smoke,smoke,smoke,smoke \
  -e API_TOKEN_SALT=smoke -e ADMIN_JWT_SECRET=smoke \
  -e JWT_SECRET=smoke -e TRANSFER_TOKEN_SALT=smoke \
  -e ENCRYPTION_KEY=smokesmokesmokesmokesmokesmoke= \
  "$IMG" >/dev/null
ok=0
for i in $(seq 1 24); do
  sleep 5
  if docker exec "$NAME" wget -qO- http://127.0.0.1:1337/_health >/dev/null 2>&1; then
    ok=1; echo "smoke: /_health ok after ~$((i*5))s"; break
  fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != "true" ]; then
    echo "smoke: container exited after ~$((i*5))s"; break
  fi
done
if [ "$ok" != "1" ]; then
  echo "SMOKE FAILED - logs follow"; docker logs "$NAME" 2>&1 | tail -40
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  exit 1
fi
docker rm -f "$NAME" >/dev/null 2>&1 || true
