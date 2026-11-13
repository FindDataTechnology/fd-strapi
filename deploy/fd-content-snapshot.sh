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
    # 快照提交的父就是刚构建的那版源码，回退只能回到它——不能回 origin/main。
    PREV=$(git rev-parse HEAD)
    git -c user.name=fd-content-bot -c user.email=bot@finddatatech.cloud \
      commit -qm "[content-snapshot] $(date -u +%FT%TZ) Strapi published-content archive [ci skip]"
    if git push -q "https://x-access-token:${GITHUB_TOKEN}@github.com/FindDataTechnology/fd-official-web.git" HEAD:main; then
      echo "snapshot: pushed $(git rev-parse --short=7 HEAD)"
    else
      # 2026-11-13 实修：原为 `git reset --hard origin/main`，而构建机（cheap1）的
      # origin/main 是 2026-10-17 的陈旧 GitHub 镜像——`/opt/fd/fd-web-deploy.sh`
      # 自己注释着「github fallback disabled — 落后 gitee/main」，这正是 10-17 事故的
      # 同一条线。推送用 scs001 凭据必然 403，于是每次部署都把工作树丢回那条旧线；
      # 两轮构建重叠时，后一轮在容器里读到的就是旧的 package.json——实历报
      # `Missing script: showcase:fetch`（该脚本 2026-10-17 之后才有）。
      # 回退目标应是本次构建的源提交，与任何远端无关。
      echo "snapshot: push failed, dropping local commit (back to $PREV)"
      git reset -q --hard "$PREV"
    fi
  fi
fi
