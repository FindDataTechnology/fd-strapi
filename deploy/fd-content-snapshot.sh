#!/usr/bin/env bash
# fd-content-snapshot — 部署成功后归档三集合拉取产物（审计档案）。
# 由 /opt/fd/fd-web-deploy.sh 尾部调起。
# 1) 无条件：rsync 到节点本地档案仓 /opt/fd-strapi/content-archive（git 历史，
#    可 diff 可回溯）；
# 2) 若构建 env 有 GITHUB_TOKEN：同时回提交到官网仓 main（[ci skip] 防 CI 烧额度）。
#    注：该仓 deploy key 被仓库设置禁用，细粒度 PAT 待用户裁决——在有凭据前，
#    仓内快照以本地档案仓为准（夜间 pg_dump 之外的第二份内容灾备）。
set -u
[ -f /opt/fd/fd-web-build.env ] && . /opt/fd/fd-web-build.env
WORK="${1:-/opt/fd/build/fd-official-web}"
ARCH=/opt/fd-strapi/content-archive

cd "$WORK" || exit 0
[ -d src/content/briefings ] || { echo "snapshot: no workdir content"; exit 0; }

# --- 1) 本地档案仓 ---
mkdir -p "$ARCH"
rsync -a --delete src/content/briefings src/content/academy src/content/research "$ARCH/"
git -C "$ARCH" add -A
if git -C "$ARCH" diff --cached --quiet; then
  echo "snapshot: no change"
else
  git -C "$ARCH" -c user.name=fd-content-bot -c user.email=bot@finddatatech.cloud \
    commit -qm "[content-snapshot] $(date -u +%FT%TZ)"
  echo "snapshot: archived $(git -C "$ARCH" rev-parse --short=7 HEAD)"
fi

# --- 2) 仓内快照（需凭据） ---
if [ -n "${GITHUB_TOKEN:-}" ]; then
  git add src/content/briefings src/content/academy src/content/research 2>/dev/null || exit 0
  if ! git diff --cached --quiet; then
    git -c user.name=fd-content-bot -c user.email=bot@finddatatech.cloud \
      commit -qm "[content-snapshot] $(date -u +%FT%TZ) Strapi published-content archive [ci skip]"
    if git push -q "https://x-access-token:${GITHUB_TOKEN}@github.com/FindDataTechnology/fd-official-web.git" HEAD:main; then
      echo "snapshot: pushed $(git rev-parse --short=7 HEAD)"
    else
      echo "snapshot: push failed, dropping local commit"
      git reset -q --hard origin/main
    fi
  fi
fi
