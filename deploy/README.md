# fd-strapi 节点侧部署

栈构成：strapi（经构建池出片的镜像，512m）+ postgres:16-alpine（192m）+
规则清单只读挂载 + uploads 命名卷。镜像构建不在节点上（本仓 Dockerfile 经
私有构建池出片）；节点只需要 docker + compose 插件。

## 0. 目录布局与前置

节点上选一个目录（下称 `$DEPLOY`，例如 `/opt/fd-strapi`），最终形态：

```
/opt/fd-strapi/
  compose.yml                  # 本目录的 compose.yml
  .env                         # cp env.example .env 后逐项填写（秘钥见文件头注释）
  rules/
    internal-identifiers.txt   # 规则清单（从 finddata 事实源同步，见 §4）
```

`.env` 要点：

- 秘钥全部现场生成：`openssl rand -base64 32`；`APP_KEYS` 是逗号分隔**四个**；
- `FD_STRAPI_IMAGE` 填构建池出的镜像引用；
- `DATABASE_PASSWORD` 同时被 compose 插值给 postgres 初始化，两服务自动一致；
- 绝不设置 `DEV_SEED` / `MIGRATE_CONTENT`（见 env.example 尾注）。

首次把规则清单放进去（在开发机 finddata 工作区跑同步，产物拷到节点）：

```sh
# 开发机：fd-strapi 仓内（事实源见 RULES.md）
npm run rules:sync && scp src/rules/internal-identifiers.txt \
  <node>:/opt/fd-strapi/rules/internal-identifiers.txt
```

离线校验清单（不 build 不 pull）：`docker compose config`。

## 1. 起栈

```sh
cd $DEPLOY
docker compose up -d
docker compose ps          # 等 strapi healthy（healthcheck 打 /_health）
curl -fsS http://127.0.0.1:1337/_health
```

首次启动 bootstrap 会幂等建好 zh/en locale（默认 zh），无需后台手工点。

对外形态：默认端口只绑 `127.0.0.1:1337`，由节点上的反代（caddy/nginx 等）
终结 TLS（`https://cms.finddatatech.cloud`）后转发——`.env` 的
`PUBLIC_URL` 已指向该域名。要让入站 Docker 网络的容器直连或换节点端口：
改 `.env` 的 `FD_STRAPI_BIND` / `FD_STRAPI_PORT`（见 compose.yml 注释），
`docker compose up -d` 重建。

## 2. 首启建管理员

一次性 CLI（不需要服务在线；需要在 `.env` 就绪后跑）：

```sh
docker compose run --rm strapi npx strapi admin:create-user \
  --firstname=Main --lastname=Editor \
  --email=<主编邮箱> --password=<强密码>
```

之后登 `https://cms.finddatatech.cloud/admin`（本地回环直连则是
`http://127.0.0.1:1337/admin`）。研究员账号用后台邀请（角色 Author，只能存
草稿不能发布）；主编用 Editor；见仓内 README「角色映射」一节。

## 3. 建只读 API token（给官网构建拉内容）

后台 **Settings → Global Settings → API Tokens → Create new API Token**，
类型 **Read-only**，名字如 `official-web-read-only`。**accessKey 只在创建
完成页显示一次**，即时复制交给官网构建侧作为 `STRAPI_READ_TOKEN`。
等价程序化路径（超管 JWT `POST /admin/api-tokens`）见仓内 README。

## 4. 一次性内容导入（既有官网 md → Strapi）

导入脚本走已构建产物（`strapi start` 模式，容器内不需要 develop 工具链）。
把官网仓的 md 根目录只读挂进容器，`MIGRATE_SRC` 用**容器内**路径：

```sh
docker compose run --rm \
  -e MIGRATE_SRC=/import/content \
  -v /path/to/fd-official-web/src/content:/import/content:ro \
  strapi npm run content:import:prebuilt
```

- 幂等：按 (slug, locale) 判存在，重跑输出 `新建 0 条、跳过 N 条`，退出码 0；
- 推倒重建：加 `-e MIGRATE_FORCE=1`（先删两语言变体再建）；
- 预检：zh/en 必须成对、共享字段两语言一致，不一致直接拒导。

## 5. 规则文件更新动线（免重启生效）

事实源在 finddata 工作区（`docs/xingyan/scripts/internal-identifiers.txt`，
改法见仓内 RULES.md）。更新到节点：

```sh
# 开发机：改完事实源后同步生成副本，然后覆盖写到节点
npm run rules:sync && scp src/rules/internal-identifiers.txt \
  <node>:/opt/fd-strapi/rules/internal-identifiers.txt
```

守卫**每次发布时重读磁盘上的清单**，覆盖写入即生效，无需重启。

> **注意挂载语义**：compose 是文件级 bind mount（绑 inode）。`scp` 覆盖写
> 没问题；**不要** `rm` 后新建、`mv` 改名顶替、或 rsync 默认的「临时文件+
> rename」——那会让挂载点仍指向旧 inode。rsync 请加 `--in-place`。如果已经
> 踩了，`docker compose restart strapi` 即恢复。清空/删除清单则触发
> fail-closed（发布全部被拦），这是预期防护语义。

## 6. 每夜备份（pg_dump + uploads tar）

cron 示例（节点 root crontab，03:15）：

```sh
15 3 * * * cd /opt/fd-strapi && \
  docker compose exec -T postgres pg_dump -U strapi strapi | gzip -c \
    > /var/backups/fd-strapi/db-$(date +\%F).sql.gz ; \
  docker run --rm -v fd-strapi_uploads:/data -v /var/backups/fd-strapi:/out \
    alpine tar czf /out/uploads-$(date +\%F).tgz -C /data . ; \
  find /var/backups/fd-strapi -mtime +14 -delete
```

- `-U strapi -d strapi` 换成 `.env` 里的 `DATABASE_USER` / `DATABASE_NAME`；
- uploads 卷名是 `<项目名>_uploads`（项目名 `fd-strapi`，见 compose.yml）；
- 恢复：`gunzip -c db-*.sql.gz | docker compose exec -T postgres psql -U strapi strapi`
  （先停 strapi：`docker compose stop strapi`）。

## 7. 升级镜像

构建池出新片后只改 `.env` 的 `FD_STRAPI_IMAGE` 再起：

```sh
docker compose up -d        # 只会重建镜像引用变了的 strapi 服务
```

数据库结构随内容类型代码定义（schema.json），首启自动迁移；升级前先做 §6 备份。
