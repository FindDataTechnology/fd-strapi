# fd-strapi

> **Part of the [Base line (寻数·壹座)](https://www.finddatatech.cloud/products/base) of [FindData](https://www.finddatatech.cloud)** — the content service behind the public site: a Strapi deployment with an internal-identifier gate on publish.

寻数官网（fd-official-web）编辑性内容的自托管 Strapi v5（社区版）服务。星研三集合（内参 / 学院 / 研究）今后由这里托管：研究员浏览器投稿、zh/en 双语、主编发布；官网构建期经 REST 拉取写成 markdown（见 finddata 工作区 OpenSpec 变更 `strapi-content-publishing`）。

本仓当前是**服务骨架 + 内容已迁入 + 生产打包/部署清单**（变更任务 1.1–1.6、3.1–3.2、5.1 仓内部分完成）：项目 + 内容模型 + i18n + 编辑器 + 既有 16 篇 md 导入（幂等脚本）+ 角色/只读 token 验证 + 发布机检（RULES.md）+ Dockerfile 与 `deploy/` compose 栈，本地能起、能无头验证。镜像经私有构建池出片、节点侧操作序列见 `deploy/README.md`。

## 快速开始（本地开发）

前置：Node 22 LTS（本机 brew `node@22`；Strapi v5 官方支持 20/22/24）。

```sh
export PATH=/opt/homebrew/opt/node@22/bin:$PATH   # 若默认 node 不是 22
npm run develop            # 普通启动（不种数据、不开公开读权限）
DEV_SEED=1 npm run develop # 开发验证启动（见下）
```

- 后台 <http://localhost:1337/admin>。本地开发管理员（抛弃式，仅本地）：
  `dev@local.test` / `DevOnly123456`（由 `npm run strapi admin:create-user` 建）。
- 数据库：默认 sqlite（`.tmp/data.db`），**开发库是抛弃式的**——删掉重启即可从零重建；`.env` 里的密钥全部是本地随机值，不含任何生产凭据。生产另配 Postgres（`config/database.ts` 已支持 `DATABASE_CLIENT=postgres`）。

### DEV_SEED=1（仅开发用）

`src/index.ts` 的 bootstrap 在 `DEV_SEED=1` 时：

1. 给 public 角色授予三内容类型的 `find` / `findOne` 权限（免 token 无头验证用；**生产不要设 DEV_SEED**，官网拉取走只读 API token，见变更任务 1.6/4.x）；
2. 幂等地为三个内容类型各建 zh/en 一条已发布样例（slug：`dev-sample-briefing` / `dev-sample-course` / `dev-sample-research`）。幂等按（slug, locale, 已发布）判重，重启不会重复。

无头验证：

```sh
curl 'http://localhost:1337/api/briefings?locale=*'        # 注意是 * 不是 all，见下
curl 'http://localhost:1337/api/courses?locale=*'
curl 'http://localhost:1337/api/research-articles?locale=*'
```

## 内容类型（API 契约，固定不改）

官网拉取脚本按以下端点写死；displayName 仅是后台显示。

| API id | 端点 | displayName | 官网集合目录 |
| --- | --- | --- | --- |
| `briefing` | `/api/briefings` | 内参 Briefing | `src/content/briefings` |
| `course` | `/api/courses` | 学院课程 Course | `src/content/academy`（映射由官网脚本负责） |
| `research-article` | `/api/research-articles` | 研究 Research Article | `src/content/research` |

字段与 fd-official-web `src/content.config.ts` 的 zod schema 逐一对齐（zod 必填的都有）：

- **briefing**：`slug`(uid 必填) `title`(必填) `summary`(text 必填) `date`(date 必填, YYYY-MM-DD) `tags`(json, 字符串数组) `sources`(json, 字符串数组) `body`(richtext 必填)
- **course**：`slug` `title` `summary` `order`(integer, 默认 10) `pack_url`(string, 默认 '') `source_material`(text) `body`
- **research-article**：`slug` `title` `summary` `date` `kind`(**枚举 paper/casestudy/note，必填**——zod 里有，基线字段表没列，已补) `tags` `sources` `body`

三类均 `draftAndPublish: true`。本地化策略（i18n localized）：

- **随语言变**：title / summary / tags / sources / source_material / body
- **双语共享**（非本地化字段，i18n 中间件自动同步到同文档所有 locale 变体）：`slug`（双语成对键，zh/en 必须同值）、`date`、`kind`、`order`、`pack_url`

`body` 为 richtext 字段，**语义是 markdown 源文本**（design.md D3）：研究员直接粘贴 markdown，发布产物即 md，不走 Strapi Blocks JSON。

## i18n（zh 默认 + en）

Strapi 5.58 的 i18n 插件**不读** `config/plugins.ts` 里的 v4 式 `defaultLocale`/`locales` 键（写了也不生效——实测空库只会得到内置 en）。本项目用两处可复现机制：

1. `.env` 的 `STRAPI_PLUGIN_I18N_INIT_LOCALE_CODE=zh`：空库初始化的首个 locale（同时成为默认 locale）；
2. `src/index.ts` bootstrap 的 `ensureLocales()`：每次启动幂等对齐——补齐缺失的 zh/en locale 记录、把默认 locale 设为 zh。

因此任何环境（本地 sqlite / 生产 Postgres）从空库起都会得到同一套语言配置，无需后台手工点。

## markdown 编辑器（任务 1.4 状态：已装成，未回退）

`strapi-plugin-wysiwyg-react-md-editor@5.8.3`（peer `@strapi/strapi ^5.0.2`，v5 兼容；基于 `@uiw/react-md-editor`，带预览）。整体替换后台默认 WYSIWYG，不改变 `body` 的存储格式（仍是 richtext 文本）。配置在 `config/plugins.ts` 的 `'wysiwyg-react-md-editor'` 块；`npm run build`（生产构建，TS + admin panel）已验证通过。

注意：装它必须**钉版本 `@5.8.3`**——裸 `npm install strapi-plugin-wysiwyg-react-md-editor` 会解析到 4.4.1（peer 依赖 @strapi/plugin-graphql@4，与 v5 冲突直接报 ERESOLVE）。

## 给官网拉取脚本的事实（v5.58 实测）

- **字段平铺在条目上**：响应是 `{ "data": [ { id, documentId, slug, title, summary, date, tags, sources, body, createdAt, updatedAt, publishedAt, locale }, ... ], "meta": { pagination } }`——没有 v4 的 `attributes` 包裹层；`tags`/`sources` 是真 JSON 数组，`body` 是 md 源字符串。
- **取全部 locale 用 `?locale=*`**。`?locale=all` 返回 **HTTP 200 + 空 data**（静默，v4 的 `all` 在 v5 内部换成了 `*`）——拉取脚本的 fail-closed 预检（条目数骤降即非零退出）要防的正是这类静默空。
- zh/en 两个语言版本是**同一 documentId 的两条记录**（`localizations` 是按 document_id 联的虚拟关系），共享同一 `slug`；REST 拉回来后按 `locale` 分拣写 `<locale>/<slug>.md` 即可。
- 无 `locale` 参数返回**默认 locale（zh）**；只返回已发布条目（v5 REST 默认 status=published）。
- `documentId` 是稳定标识（uid 字符串），`id` 是数据库自增（换库会变），拉取脚本如需缓存去重键应用 documentId。

## 内容导入（既有 16 篇 md 一次性迁移，任务 3.1/3.2）

`src/migrate-content.ts`（由 `src/index.ts` 的 `MIGRATE_CONTENT=1` bootstrap 分支动态 import）把官网仓
fd-official-web 的 `src/content/{briefings,academy,research}/{zh,en}/*.md`（目录名映射
briefings→`api::briefing.briefing`、academy→`api::course.course`、research→`api::research-article.research-article`）
导入为 zh/en 双语已发布条目。js-yaml 只在迁移分支动态加载；它是生产依赖
（容器内一次性导入走 `content:import:prebuilt`，见 `deploy/README.md` §4——
运行时镜像没有 develop 工具链，`strapi start` 模式跑同一段 bootstrap 导入逻辑）。

```sh
# 一次性跑完退出（推荐）：
MIGRATE_SRC=<fd-official-web>/src/content npm run content:import
# 注意：src 根用环境变量传——`npm run content:import -- --src X` 会被 strapi CLI
# 当成未知参数直接报错（实测），`--src`/`--force` 只在直接 node/develop 场景可达。

# 常驻服务 + 启动即迁移（开发验证时）：
MIGRATE_CONTENT=1 MIGRATE_SRC=<md根> DEV_SEED=1 npm run develop
```

机制与幂等性（实测）：

- **先建 zh（默认 locale、published），再在 data 里带 zh 的 documentId 建 en 变体**；en 载荷必须显式带全部必填非本地化字段（slug/date/kind/order/pack_url），document service 不会自动复制。
- **幂等：按 (slug, locale) 判存在，已存在则跳过**——重跑输出 `新建 0 条、跳过 16 条`，退出码 0。`MIGRATE_FORCE=1`（或进程 argv 含 `--force`）先删两语言变体再重建。
- 导入前预检：zh/en 必须成对；共享字段（date/kind/order/pack_url）两语言不一致则拒导；slug 取自文件名；date 归一为 `YYYY-MM-DD`（js-yaml 的 YAML-1.1 schema 会把裸日期解析成 Date，已处理）；正文 body=md 正文原文（尾部换行与官网拉取侧写盘规则一致地规范化）。
- 验收（3.2 + 切换判据 D8 预演，均已实测通过）：REST `?locale=*` 拉回的 slug 集合与源文件名清单 diff=0（8 slug × 2 locale）；在 fd-official-web 跑 `STRAPI_URL=http://localhost:1338 node scripts/fetch-strapi.mjs` 后 `git status` 对三个内容目录**零输出**（拉取回写产物与仓内 md 逐字节一致）。注意：做这个预演时库里不能有额外已发布条目（DEV_SEED 的 dev-sample-* 样例要先删，否则会写出多余文件）。

## 角色映射：投稿 / 审发分离（任务 1.5，实测）

社区版（CE）默认后台角色即够用，无需自定义角色/权限：

| 人 | 后台角色（code） | 权限边界 |
| --- | --- | --- |
| 研究员 | **Author**（`strapi-author`） | 能建/改**自己的草稿**，**不能 publish**（publish 按钮/接口 403） |
| 主编 | **Editor**（`strapi-editor`） | 可管理并发布所有人的内容 |
| 管理员 | **Super Admin**（`strapi-super-admin`） | 全部权限 |

实测记录（本地 sqlite，超管建 Author 用户 → Author 建草稿 → 各自尝试发布）：

```
Author creates draft    -> 201  publishedAt=null（草稿）
Author   publish -> POST /content-manager/collection-types/api::briefing.briefing/:documentId/actions/publish
                      -> 403 PolicyError "Policy Failed"
SuperAdmin publish 同一篇 -> 200  publishedAt=2026-10-15T19:17:29.893Z
```

v5.58 建 Author 用户的两步配方（后台面板等价操作：Settings→Administration panel→Users→Invite new user，选 Author 角色，对方经邮件链接完成注册）：

1. 超管 JWT `POST /admin/users` `{email, firstname, lastname, roles:[<Author角色id>]}`（**不带 username/password**，5.58 校验会 400）→ 返回 `registrationToken`；
2. `POST /admin/register` `{registrationToken, userInfo:{firstname, lastname, password}}` → 注册即登录，返回该用户 access token。

## 只读 API token（任务 1.6，实测）

生产环境后台操作路径：**Settings → Global Settings → API Tokens → Create new API Token**，类型选 **Read-only**，名字如 `official-web-read-only`。**accessKey 只在创建完成页显示一次**，即时复制交给官网构建侧（`STRAPI_READ_TOKEN`）。等价的程序化路径：超管 JWT `POST /admin/api-tokens` `{name, description, type:"read-only", lifespan:null}`（非 custom 类型**不能**带 permissions 数组，read-only 天生只含全部内容类型的读动作）。

三条实测验证（Bearer accessKey）：

```
1) GET  /api/briefings?locale=*   -> 200，仅返回已发布条目（zh/en 平铺在同一 data 里）
2) 专门建一篇草稿（无 publishedAt）-> 该条目不出现在 token 拉取结果里（REST 默认 status=published）
3) POST /api/briefings（带 token）-> 403 ForbiddenError（read-only 只放行读）
```

本地验证库里的 token/密码均只存在于抛弃式 sqlite（`.tmp/*.db`）与本地临时文件，未写入任何真实生产凭据。

## 目录导览

```
config/plugins.ts          # i18n 说明（不在此配置）、md 编辑器开关、users-permissions/upload
config/database.ts         # sqlite（默认）/postgres 切换
src/index.ts               # bootstrap：ensureLocales() + DEV_SEED + MIGRATE_CONTENT 分支
src/migrate-content.ts     # 既有 md 一次性导入（任务 3.1，幂等，见「内容导入」节）
src/api/briefing/          # content-types/briefing/schema.json + controllers/routes/services 工厂
src/api/course/            # 同上（官网侧叫 academy）
src/api/research-article/  # 同上（官网侧叫 research）
database/migrations/       # 空（内容类型以 schema.json 代码定义）
Dockerfile                 # 生产镜像（多阶段：build → prune → 非 root runtime；经构建池出片）
.dockerignore              # 构建上下文排除（规则副本不进镜像，生产由节点挂载提供）
deploy/compose.yml         # 节点栈：strapi + postgres16 + 规则只读挂载 + uploads/pgdata 卷
deploy/env.example         # 生产环境变量模板（秘钥 openssl rand -base64 32）
deploy/README.md           # 节点侧操作序列（起栈/建管理员/token/导入/规则更新/备份）
```

## 下一步（后续任务波次）

- 4.x 官网拉取脚本收尾、5.x 节点侧实机部署（清单已就绪，见 `deploy/README.md`）、6.x 切换验收（3.x 导入与 D8 预演已完成，见「内容导入」节）
