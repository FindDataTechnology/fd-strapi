// 发布前内部标识拦截（发布生命周期钩子，OpenSpec 变更 strapi-content-publishing 2.1–2.3）。
//
// 挂法：document service 中间件 `strapi.documents.use()`（Strapi 5.58 实测可用的
// 唯一干净拦截点），由三个内容类型的 content-type lifecycles 文件在模块加载时
// 各自幂等注册（registerPublishGuard）。为什么不用别的挂法（读 node_modules
// @strapi/core 5.58 源码 + 实测得出的证据链）：
//
//  1. content-type lifecycles 没有 beforePublish/afterPublish 钩子
//     （@strapi/types、@strapi/core 全量 grep 无 beforePublish）。
//  2. publish() 的内部流程是「先删旧发布行 → 改草稿 → 复制草稿为发布行」
//     （@strapi/core/dist/services/document-service/repository.js 的 publish()），
//     db 级 beforeCreate 在删除旧发布行【之后】才触发——若在生命周期里抛错，
//     已发布内容会先被删掉再失败，造成公开内容丢失。中间件在 publish() 执行
//     【之前】拦截，任何写库都还没发生（content-manager 的 publish 控制器还包
//     了 strapi.db.transaction，抛错整体回滚）。
//  3. 覆盖面：所有发布路径最终都走 `strapi.documents(uid).publish()`——admin
//     的 POST /content-manager/collection-types/:model/:id/actions/publish、
//     bulk publish（publishMany 逐条调 publish）、content-releases 定时发布。
//     唯一旁路是 create/update 带 `status:'published'`（admin 表单「保存并发布/
//     新建即发布」走这条路，repository 内部直调 publish 函数、不经过中间件链），
//     本守卫对这两个 action 也做同样的检查，堵住旁路。
//
// fail-closed（任务 2.3）：打包规则副本缺失、清单为空或解析失败 → 拒绝一切发布，
// 错误信息明说「规则清单缺失/为空，发布全部拦截」。清单每次发布时重新读取
// （文件很小、发布是人工低频操作），因此清空副本无需重启即可生效/恢复。

import { errors } from '@strapi/utils';
import { loadPackedRules, scanEntry, type FieldHit, type Rule } from './internal-identifiers';

type Strapi = import('@strapi/strapi').Core.Strapi;

/** 本守卫检查的内容类型范围：api 命名空间下启用 draftAndPublish 的类型（当前即 briefing/course/research-article，未来新增类型自动纳入） */
function isGuardedContentType(uid: unknown, contentType: unknown): boolean {
  if (typeof uid !== 'string' || !uid.startsWith('api::')) return false;
  const opts = (contentType as { options?: { draftAndPublish?: boolean } } | undefined)?.options;
  return opts?.draftAndPublish === true;
}

/** fail-closed：加载规则清单，失败即抛错拦截发布 */
function requireRules(): { rules: Rule[]; path: string } {
  const loaded = loadPackedRules();
  if (!loaded.ok) {
    throw new errors.ApplicationError(
      `发布被拦截：规则清单缺失/为空，发布全部拦截（${loaded.reason}；打包副本期望位于 ${loaded.path}）。` +
        `请恢复清单后重试：在 fd-strapi 运行 npm run rules:sync 重新生成打包副本。`
    );
  }
  return loaded;
}

/** 汇总命中并抛出 ApplicationError（→ admin API 4xx，报文含分类 + slug + 字段名） */
function throwIfHits(hits: FieldHit[], slug: string, uid: string, locale: string): void {
  if (hits.length === 0) return;
  const MAX = 5;
  const shown = hits
    .slice(0, MAX)
    .map((h) => `【${h.category}】${uid}「${slug}」(${locale}) 字段 ${h.field} 命中 ${h.pattern}："${h.snippet}"`)
    .join('；');
  const more = hits.length > MAX ? `；…等共 ${hits.length} 处` : '';
  throw new errors.ApplicationError(
    `发布被拦截：内容含内部标识，机检未通过。命中 ${hits.length} 处：${shown}${more}。` +
      `请改写以上字段后重新发布（规则清单：src/rules/internal-identifiers.txt，同步方式见 RULES.md）。`
  );
}

/** 与 document service publish() 相同的 locale 作用域：未给 → 默认 locale；'*' → 全部；数组/单值 → 对应 locale */
async function draftWhereForParams(
  strapi: Strapi,
  uid: string,
  documentId: unknown,
  localeParam: unknown
): Promise<Record<string, unknown> | null> {
  const where: Record<string, unknown> = { documentId, publishedAt: null };
  const contentType = strapi.contentType(uid as never);
  const localization = (
    strapi as unknown as {
      localization?: {
        isLocalizedContentType: (ct: unknown) => boolean;
        getDefaultLocale: () => Promise<string | null>;
      };
    }
  ).localization;
  const localized = localization?.isLocalizedContentType(contentType) ?? false;
  if (localized) {
    let locale = localeParam;
    if (locale === undefined || locale === null || locale === '') {
      locale = (await localization?.getDefaultLocale()) ?? null;
    }
    if (locale !== '*' && locale !== null) {
      where.locale = locale; // 字符串或字符串数组（数组按 IN 语义）
    }
  }
  return where;
}

/** 取条目 DB 行集合里第一个非空 slug（报错定位用），找不到时给兜底文案 */
function pickSlug(rows: Array<Record<string, unknown>>, fallbackData: unknown): string {
  for (const row of rows) {
    if (typeof row.slug === 'string' && row.slug) return row.slug;
  }
  const fromData = (fallbackData as { slug?: unknown } | undefined)?.slug;
  return typeof fromData === 'string' && fromData ? fromData : 'slug未知';
}

function rowLocale(row: Record<string, unknown>): string {
  return typeof row.locale === 'string' ? row.locale : '默认';
}

/** action === 'publish'：把将要被发布的草稿行取出来逐一机检 */
async function guardPublishAction(strapi: Strapi, uid: string, params: Record<string, unknown>): Promise<void> {
  const documentId = params.documentId;
  if (typeof documentId !== 'string' || !documentId) return; // 留给 publish() 自己的参数校验报错
  const { rules } = requireRules();
  const where = await draftWhereForParams(strapi, uid, documentId, params.locale);
  const rows = (await (strapi.db as unknown as {
    query: (u: string, o?: unknown) => { findMany: (q: unknown) => Promise<Array<Record<string, unknown>>> };
  }).query(uid).findMany({ where })) as Array<Record<string, unknown>>;
  for (const row of rows) {
    throwIfHits(scanEntry(row, rules), pickSlug(rows, undefined), uid, rowLocale(row));
  }
}

/** action === 'create'/'update' 且 status==='published'（admin「新建即发布」旁路）：检查提交的 data；update 还要检查将被合并发布的现有草稿行 */
async function guardUpsertAsPublished(
  strapi: Strapi,
  uid: string,
  params: Record<string, unknown>
): Promise<void> {
  const { rules } = requireRules();
  const documentId = params.documentId;

  // update 且已有草稿：先检现有草稿行（合并发布的另一半），再检新提交的数据
  if (typeof documentId === 'string' && documentId) {
    const where = await draftWhereForParams(strapi, uid, documentId, params.locale);
    const rows = (await (strapi.db as unknown as {
      query: (u: string, o?: unknown) => { findMany: (q: unknown) => Promise<Array<Record<string, unknown>>> };
    }).query(uid).findMany({ where })) as Array<Record<string, unknown>>;
    for (const row of rows) {
      throwIfHits(scanEntry(row, rules), pickSlug(rows, params.data), uid, rowLocale(row));
    }
  }
  if (params.data && typeof params.data === 'object') {
    const locale = (params as { locale?: unknown }).locale;
    const localeLabel = typeof locale === 'string' ? locale : '默认';
    throwIfHits(
      scanEntry(params.data, rules),
      pickSlug([], params.data),
      uid,
      localeLabel
    );
  }
}

/** document service 中间件本体：拦 publish，以及 create/update(status=published) 旁路 */
function makeMiddleware(strapi: Strapi) {
  return async (
    ctx: {
      uid: unknown;
      contentType: unknown;
      action: unknown;
      params: Record<string, unknown>;
    },
    next: () => Promise<unknown>
  ): Promise<unknown> => {
    const { action, uid, contentType, params } = ctx;
    if (isGuardedContentType(uid, contentType)) {
      if (action === 'publish') {
        await guardPublishAction(strapi, uid as string, params ?? {});
      } else if (
        (action === 'create' || action === 'update') &&
        (params as { status?: unknown } | undefined)?.status === 'published'
      ) {
        await guardUpsertAsPublished(strapi, uid as string, params ?? {});
      }
    }
    return next();
  };
}

/**
 * 注册发布拦截（幂等：同一 strapi 实例只挂一次；develop 热重载或多个
 * lifecycles 文件重复调用都安全——实例记在 globalThis 的 WeakSet 上，
 * 模块重新加载也不会丢）。
 *
 * 调用时机：三个内容类型的 src/api/<ct>/content-types/<ct>/lifecycles.ts
 * 在应用加载（register 阶段的 loadApplicationContext）时 import 本模块并调用；
 * 此时 global.strapi 已由 createStrapi 赋好值，strapi.documents 容器项可
 * 惰性取得，use() 注册进共享 middleware manager，对后续所有请求生效。
 */
export function registerPublishGuard(strapiLike: unknown): void {
  const strapi = strapiLike as Strapi | undefined;
  if (
    !strapi ||
    typeof (strapi as unknown as { documents?: { use?: unknown } }).documents?.use !== 'function'
  ) {
    // 理论上到不了这里（lifecycles 加载晚于 global.strapi 赋值）；真发生时宁可大声失败，不可静默无防护。
    throw new Error(
      '[publish-guard] 注册失败：加载 lifecycles 时 strapi.documents 不可用，内部标识发布拦截未启用。'
    );
  }
  const g = globalThis as unknown as Record<symbol, WeakSet<object>>;
  const KEY = Symbol.for('fd-strapi/rules/publish-guard-instances');
  const seen: WeakSet<object> = (g[KEY] ??= new WeakSet());
  if (seen.has(strapi)) return;
  seen.add(strapi);
  // 注：`strapi.documents.use` 在 5.58 的类型文件里因联合类型坍缩报 TS2339，
  // 运行时确实存在（@strapi/types/dist/modules/documents/index.d.ts 明确声明
  // `use: (cb: Middleware) => Service`），这里按实际形状断言。
  const documentsService = strapi.documents as unknown as {
    use: (cb: unknown) => unknown;
  };
  documentsService.use(makeMiddleware(strapi));
  strapi.log?.info?.(
    '[publish-guard] 内部标识发布拦截已启用：document middleware 覆盖 publish 与 create/update(status=published)，规则清单 src/rules/internal-identifiers.txt（缺失/为空时 fail-closed）'
  );
}
