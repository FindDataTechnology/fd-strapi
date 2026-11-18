# 发布拦截：内部标识机检（RULES）

星研三集合（briefing 内参 / course 学院课程 / research-article 研究文章）在
fd-strapi 里**发布前的机检 gate**：草稿命中内部标识规则清单的任何模式 →
发布被阻止；规则清单缺失/为空/损坏 → 拒绝一切发布（fail-closed）。对应
OpenSpec 变更 `strapi-content-publishing` 任务 2.1–2.3。

## 机制（为什么是 document middleware）

拦截点是 **document service 中间件 `strapi.documents.use()`**（Strapi 5.58），
由三个内容类型的
`src/api/<ct>/content-types/<ct>/lifecycles.ts`（briefing / course /
research-article 三处）在应用加载时各自幂等注册，共享检查模块为
`src/rules/publish-guard.ts` + `src/rules/internal-identifiers.ts`。

选择该挂法的证据（读 `node_modules/@strapi/core@5.58` 源码 + 实测）：

1. **content-type lifecycles 没有 publish 钩子**。`@strapi/types`、
   `@strapi/core` 全量检索不存在 `beforePublish/afterPublish`；lifecycles 只有
   db 级 before/afterCreate/Update/Delete 等。
2. **db 级钩子拦 publish 会丢已发布内容**。document service 的 `publish()`
   流程是「先删旧发布行 → 改草稿 → 把草稿复制为发布行」；`beforeCreate` 在
   删除旧发布行**之后**才触发，此时抛错 = 已发布版本已被删掉而新版本没建成。
   中间件在 `publish()` 执行之前拦截，任何写库都未发生（content-manager 的
   publish 控制器外层还有 `strapi.db.transaction`，抛错整体回滚）。
3. **覆盖所有发布路径**。admin 面板的
   `POST /content-manager/collection-types/api::<ct>.<ct>/:documentId/actions/publish`、
   批量发布（publishMany 逐条走 publish）、content-releases 定时发布，最终都
   调 `strapi.documents(uid).publish()`，中间件全覆盖。
4. **堵住唯一旁路**：`create` / `update` 带 `status: 'published'`（admin 表单
   「新建即发布/保存并发布」）在 repository 内部直调 publish 函数、不经过
   `publish` action 的中间件链。守卫对这两个 action（且 status=published 时）
   做同样检查：检查提交的 data，update 场景还检查将被合并发布的现有草稿行。

检查范围：条目的**全部文本面**——所有字符串字段（title/summary/body/
source_material/slug 等）+ 字符串数组元素（tags/sources，报错定位到
`tags[2]` 这样的下标）。逐条规则匹配（清单见下）。

发布侧只拦发布：草稿随便写、随便存；研究员改完再点发布即可。unpublish
（下架）永不拦截。

## 错误报文长什么样

命中（HTTP 400，ApplicationError）：

```
发布被拦截：内容含内部标识，机检未通过。命中 2 处：【内部代号】api::briefing.briefing「my-briefing-slug」(zh) 字段 body 命中 drillcust："…部署在 drillcust 节点…"；【节点与主机】… 字段 tags[1] 命中 <节点名>："<节点名>"。请改写以上字段后重新发布（规则清单：src/rules/internal-identifiers.txt，同步方式见 RULES.md）。
```

含**命中分类名、条目 slug、locale、字段名（数组带下标）、命中模式与上下文
片段**，最多列 5 处。

fail-closed（清单缺失/为空/坏行，HTTP 400）：

```
发布被拦截：规则清单缺失/为空，发布全部拦截（规则清单为空…；打包副本期望位于 …/src/rules/internal-identifiers.txt）。请恢复清单后重试：在 fd-strapi 运行 npm run rules:sync 重新生成打包副本。
```

## 规则清单：事实源与同步（rules:sync）

- **唯一事实源**：finddata 工作区
  `docs/xingyan/scripts/internal-identifiers.txt`（分类+模式清单，格式：
  `#` 注释、空行跳过、`<类别> | <字面串 或 /正则/>`，均大小写不敏感；其
  文件头有指回本项目的互指针注释）。语义参照实现：
  `docs/xingyan/scripts/sanitize_check.py`。
- **打包副本**：`src/rules/internal-identifiers.txt`，由
  `npm run rules:sync`（`scripts/sync-rules.mjs`）生成——头部带生成时间与
  来源路径注释，正文为事实源原文。**勿手改副本**，改了也会被下次同步覆盖。
- 加/改规则的流程：改事实源 → 在 fd-strapi 跑 `npm run rules:sync` →
  立即生效（清单在每次发布时重新读取，无需重启）。
- 源路径可用 `FD_RULES_SRC` 覆盖：
  `FD_RULES_SRC=/path/to/internal-identifiers.txt npm run rules:sync`。
- `npm run build` 已前置 `rules:sync`（package.json scripts 链），本地构建产物
  永远从事实源重新生成副本。**构建容器（CI/镜像构建）里没有事实源**——此时
  同步脚本按「运行时挂载语义」跳过：副本在则保留副本、副本也不在则什么都不
  生成，均 exit 0 不炸构建；fail-closed 责任保持在运行时守卫（清单读不到即
  拦全部发布）。
- 同步前脚本会按运行时同一套语义校验源文件（坏行/空清单直接失败退出），
  不会生成让 gate 失效的副本。

## 生产运行时：清单由节点挂载提供

- 副本不进仓不进镜像（.gitignore / .dockerignore 均排除）；生产由节点把
  同步好的清单只读挂载到容器 `/app/src/rules/internal-identifiers.txt`
  （即守卫的默认解析路径），见 `deploy/compose.yml` 与 `deploy/README.md`。
- 清单路径可用环境变量 `FD_RULES_FILE` 显式指定（`src/rules/internal-identifiers.ts`
  的 `candidateRulePaths()`）：指定后该路径即唯一权威路径，不存在/为空/损坏
  一律 fail-closed，不回落候选路径。默认（未设置）行为不变。
- 挂载的是文件级 bind mount（绑 inode）：更新清单用覆盖写（scp /
  rsync --in-place），不要 rm+新建或 mv，见 deploy/README.md「规则文件更新」。

## fail-closed（任务 2.3）

发布时打包副本**缺失、清单为空、或有解析不了的行** → 一律拒绝发布（上面的
第二条报文）。清单在每次发布时从磁盘重新读取，因此把副本清空/删除后无需
重启即全拦，恢复（重跑 rules:sync）后即放行。

## 文件清单

```
src/rules/internal-identifiers.ts   # 规则解析 + 文本/条目匹配（纯逻辑）
src/rules/publish-guard.ts          # document middleware + fail-closed + 报错组装
src/api/briefing/content-types/briefing/lifecycles.ts          # 三处接线（幂等注册）
src/api/course/content-types/course/lifecycles.ts
src/api/research-article/content-types/research-article/lifecycles.ts
scripts/sync-rules.mjs              # rules:sync 同步脚本（FD_RULES_SRC 可覆盖源）
src/rules/internal-identifiers.txt  # 生成物：打包副本（勿手改）
package.json                        # scripts: rules:sync + build 前置链
```

## 无头验证配方（管理员 API）

```sh
# 登录 admin 拿 JWT（本地开发账号见 README）
TOKEN=$(curl -s http://localhost:1340/admin/login -H 'content-type: application/json' \
  -d '{"email":"dev@local.test","password":"DevOnly123456"}' | jq -r .data.token)

# 建草稿（以 briefing 为例；zh locale）
curl -s http://localhost:1340/content-manager/collection-types/api::briefing.briefing?locale=zh \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"title":"…","summary":"…","slug":"test-dirty","date":"2026-10-16","tags":["<节点名>"],"sources":[],"body":"…"}'
# → 记下 data.documentId

# 发布（主编点发布的同一条 API）
curl -i -X POST \
  http://localhost:1340/content-manager/collection-types/api::briefing.briefing/<documentId>/actions/publish?locale=zh \
  -H "Authorization: Bearer $TOKEN"
# 含内部标识 → 400 + 上面的命中报文；改干净后重发 → 200
```
