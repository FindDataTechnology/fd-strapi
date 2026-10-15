#!/usr/bin/env bash
# fd-strapi 每夜备份（cheap-1，/etc/cron.d/fd-strapi-backup 调起）。
# pg_dump 全库 + uploads 卷打包，各留 14 份滚动；栈未起则跳过（exit 0）。
# 注意两条实测教训（2026-10-16 首演练抓出）：
#   - docker compose ps -q 在栈未起时也 exit 0（空输出）——守卫必须测输出非空
#   - 无 pipefail 时 pg_dump 失败会被 gzip 的成功掩盖——必须 -o pipefail
set -uo pipefail
cd /opt/fd-strapi || exit 1
exec 9>/var/lock/fd-strapi-backup.lock
flock -n 9 || { echo "$(date -Is) skip: another backup running"; exit 0; }

[ -n "$(docker compose ps -q strapi 2>/dev/null)" ] || { echo "$(date -Is) skip: stack down"; exit 0; }
ts=$(date +%F)

docker compose exec -T postgres pg_dump -U strapi strapi | gzip > "backups/db-$ts.sql.gz" \
  || { echo "$(date -Is) FAIL: pg_dump"; exit 1; }

docker run --rm -v fd-strapi_uploads:/uploads:ro -v /opt/fd-strapi/backups:/backup alpine \
  tar czf "/backup/uploads-$ts.tgz" -C / uploads \
  || { echo "$(date -Is) FAIL: uploads tar"; exit 1; }

# 各留最近 14 份
ls -1t backups/db-*.sql.gz 2>/dev/null | tail -n +15 | xargs -r rm -f
ls -1t backups/uploads-*.tgz 2>/dev/null | tail -n +15 | xargs -r rm -f

echo "$(date -Is) ok: db-$ts.sql.gz ($(du -h "backups/db-$ts.sql.gz" | cut -f1)), uploads-$ts.tgz ($(du -h "backups/uploads-$ts.tgz" | cut -f1))"
