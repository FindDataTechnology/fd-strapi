# fd-strapi 生产镜像（OpenSpec strapi-content-publishing 任务 5.1）。
#
# 多阶段：build 阶段全量依赖 + strapi build（TS 编译 + admin 面板）→ prune 出
# 生产 node_modules；runtime 阶段非 root 运行。本文件只描述构建（经私有构建池
# 出片），本机禁 docker build。
#
# 关键取舍：
#  - 规则清单 src/rules/internal-identifiers.txt 不进镜像（同 .gitignore 语义，
#    且被 .dockerignore 排除）。npm run build 前置的 rules:sync 在构建容器里
#    无 finddata 规则源也无副本 → 按「运行时挂载语义」跳过退出 0（见
#    scripts/sync-rules.mjs）；fail-closed 责任保持在运行时守卫：节点没挂载
#    清单时发布全部被拦。
#  - runtime 目录保留空的 src/rules/ 作为挂载点：发布守卫按
#    <cwd>/src/rules/internal-identifiers.txt 解析路径（candidateRulePaths 的
#    第一候选，见 src/rules/internal-identifiers.ts），compose 以文件级只读
#    bind mount 覆盖该路径；父目录必须预先存在，否则 Docker 会把挂载目标
#    创建成目录。FD_RULES_FILE 可改指其它路径（deploy/env.example）。
#  - tsconfig.json 进 runtime：strapi start 以它判定 TS 工程并把运行目录解析
#    到 dist/（@strapi/strapi dist/src/cli/commands/start.js）；缺了它 strapi
#    会按 JS 工程找 src/index.js 直接失败。
#  - src/ 源码与 typescript（devDep）不进 runtime：strapi start 只消费 dist；
#    容器内一次性内容导入走 content:import:prebuilt（strapi start 模式），
#    不需要 develop 工具链。

FROM node:22-alpine AS build
# better-sqlite3（生产依赖，sqlite 开发态用）是原生模块：装编译工具兜底；
# 只存在于 build 阶段，不进 runtime。
RUN apk add --no-cache python3 make g++
WORKDIR /app

# 先只拷清单装依赖，最大化层缓存
COPY package.json package-lock.json ./
RUN npm ci

# 拷源（.dockerignore 已排除 node_modules/.git/dist/.env*/规则副本等）
COPY . .

# rules:sync 在此打印「无规则源与副本：按运行时挂载语义跳过…」并 exit 0（预期）
RUN npm run build \
 && npm prune --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# node 基础镜像自带非 root 用户 node（uid 1000）
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
# 构建产物：dist/（TS 编译输出 + dist/build 的 admin 面板，strapi start 与
# serve-admin-panel 都从这里解析）
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/favicon.png ./favicon.png
COPY --chown=node:node tsconfig.json ./tsconfig.json

# 挂载点与可写目录属主：
#  - src/rules/：规则清单只读挂载点（上面「关键取舍」第 2 条）
#  - public/uploads/：本地上传目录（compose 挂 uploads 卷）
#  - .tmp/：sqlite 方言启动时要 mkdir /app/.tmp（首版冒烟实测 EACCES 抓出）；
#    生产走 postgres 不用它，预建属主让 sqlite 兜底路径（冒烟/应急）可用
RUN mkdir -p src/rules public/uploads .tmp \
 && chown -R node:node src public .tmp

USER node
EXPOSE 1337
# 等价于 strapi start；走 npm script 便于复用 package.json 的入口
CMD ["npm", "run", "start"]
