// fd-strapi 应用级生命周期。
//
// DEV_SEED=1 时（仅开发）：
//   1. 给 public 角色授予三个内容类型的 find/findOne 权限，使无头 curl 验证可行；
//   2. 为三个内容类型各建 zh/en 各一条已发布样例（幂等，按 slug 判重）。
//
// 生产部署不要设置 DEV_SEED（README 有说明）。

type Strapi = import('@strapi/strapi').Core.Strapi;

const CONTENT_TYPES = [
  'api::briefing.briefing',
  'api::course.course',
  'api::research-article.research-article',
] as const;

/** 每个内容类型一对 zh/en 样例数据（zh 为基准，en 为其 locale 变体） */
const SEED: Record<
  string,
  { slug: string; zh: Record<string, unknown>; en: Record<string, unknown> }
> = {
  'api::briefing.briefing': {
    slug: 'dev-sample-briefing',
    zh: {
      slug: 'dev-sample-briefing',
      title: '开发种子·内参条目（zh）',
      summary:
        'DEV_SEED=1 时由 bootstrap 自动创建的 zh 内参样例，用于无头验证双语拉取。sqlite 开发库是抛弃式的，可随时删除。',
      date: '2026-10-16',
      tags: ['开发', '种子'],
      sources: ['fd-strapi DEV_SEED bootstrap'],
      body: '## 第一节\n\n这是 zh 版正文（markdown 源文本，语义见 design.md D3）。\n\n- 列表项一\n- 列表项二\n',
    },
    en: {
      title: 'Dev seed briefing (en)',
      summary:
        'English sample briefing created automatically by the DEV_SEED bootstrap, for headless verification of bilingual fetching.',
      date: '2026-10-16',
      tags: ['dev', 'seed'],
      sources: ['fd-strapi DEV_SEED bootstrap'],
      body: '## Section one\n\nEnglish body (markdown source text).\n\n- list item one\n- list item two\n',
    },
  },
  'api::course.course': {
    slug: 'dev-sample-course',
    zh: {
      slug: 'dev-sample-course',
      title: '开发种子·学院课程（zh）',
      summary: 'DEV_SEED 自动创建的 zh 学院课程样例。官网侧集合目录为 academy，映射由拉取脚本负责。',
      order: 1,
      pack_url: '',
      source_material: 'fd-strapi DEV_SEED bootstrap（样例出处声明）',
      body: '## 课程导语\n\n这是 zh 版课程正文（markdown 源文本）。\n',
    },
    en: {
      title: 'Dev seed course (en)',
      summary:
        'English sample academy course created by the DEV_SEED bootstrap. The website-side collection directory is academy.',
      order: 1,
      pack_url: '',
      source_material: 'fd-strapi DEV_SEED bootstrap (sample source statement)',
      body: '## Course intro\n\nEnglish course body (markdown source text).\n',
    },
  },
  'api::research-article.research-article': {
    slug: 'dev-sample-research',
    zh: {
      slug: 'dev-sample-research',
      title: '开发种子·研究文章（zh）',
      summary: 'DEV_SEED 自动创建的 zh 研究文章样例，kind=note。官网侧集合目录为 research。',
      date: '2026-10-16',
      kind: 'note',
      tags: ['开发', '种子'],
      sources: ['fd-strapi DEV_SEED bootstrap'],
      body: '## 摘要\n\n这是 zh 版研究正文（markdown 源文本）。\n',
    },
    en: {
      title: 'Dev seed research article (en)',
      summary: 'English sample research article created by the DEV_SEED bootstrap, kind=note.',
      date: '2026-10-16',
      kind: 'note',
      tags: ['dev', 'seed'],
      sources: ['fd-strapi DEV_SEED bootstrap'],
      body: '## Abstract\n\nEnglish research body (markdown source text).\n',
    },
  },
};

/** 给 public 角色补齐三类型的 find/findOne 权限（幂等，仅 DEV_SEED 时调用） */
async function grantPublicFindPermissions(strapi: Strapi): Promise<void> {
  const role = await strapi
    .query('plugin::users-permissions.role')
    .findOne({ where: { type: 'public' } });
  if (!role) {
    strapi.log.warn('[DEV_SEED] public role not found, skip permission grants');
    return;
  }
  const existing = await strapi
    .query('plugin::users-permissions.permission')
    .findMany({ where: { role: role.id } });
  const have = new Set(existing.map((p: { action: string }) => p.action));
  const wanted = CONTENT_TYPES.flatMap((uid) => [`${uid}.find`, `${uid}.findOne`]);
  const missing = wanted.filter((action) => !have.has(action));
  if (missing.length === 0) return;
  for (const action of missing) {
    // 注意：v5 的 db.query().createMany() 不写关系字段（role 关联会丢，权限成
    // 孤儿导致 403），必须逐条 create。
    await strapi.query('plugin::users-permissions.permission').create({
      data: { action, role: role.id },
    });
  }
  strapi.log.info(`[DEV_SEED] granted public: ${missing.join(', ')}`);
}

/**
 * 为一个内容类型创建 zh + en 一对已发布样例（按 locale 分别幂等）。
 *
 * v5 关键事实（读 @strapi/core document-service 源码确认）：
 *  - locale 变体 = 共享同一 documentId 的多行；`documents().create()` 的顶层
 *    documentId 参数会被丢弃，但 `data.documentId` 会透传并参与
 *    (documentId, locale, 发布态) 唯一性检查 —— 因此 en 版本在 data 里带
 *    zh 版返回的 documentId 即可挂到同一文档下。
 *  - 该路径【不会】从既有变体复制非本地化字段：required 的非本地化字段
 *    （如 slug/date/kind）必须在 en 载荷里显式给出。
 *  - `status: 'published'` 由 statusToData 转成 publishedAt；v5 的草稿/发布
 *    是同 documentId 的不同行，幂等判重按 (slug, locale, 已发布) 进行。
 *  - uid/slug 列在 v5 没有 DB 唯一索引；slug 为非本地化字段，i18n 中间件会把
 *    非本地化字段自动同步到同一文档的其他 locale 变体。
 */
async function seedLocalizedPair(strapi: Strapi, uid: string): Promise<void> {
  const { slug, zh, en } = SEED[uid];

  // strapi.documents() 的 TS 签名是按内容类型生成的字面量联合，string 变量过不了
  // 泛型约束；种子脚本按 uid 动态分发，这里放宽为运行时等价的门面。
  const documents = strapi.documents as unknown as (
    uid: string
  ) => {
    create: (params: Record<string, unknown>) => Promise<{ documentId: string }>;
  };

  const zhRow = await strapi.db.query(uid).findOne({
    where: { slug, locale: 'zh', publishedAt: { $notNull: true } },
  });
  const enCount = await strapi.db.query(uid).count({
    where: { slug, locale: 'en', publishedAt: { $notNull: true } },
  });

  let documentId = zhRow?.documentId as string | undefined;

  if (!documentId) {
    const createdZh = await documents(uid).create({ data: zh, locale: 'zh', status: 'published' });
    documentId = createdZh.documentId;
    strapi.log.info(`[DEV_SEED] ${uid}: created zh documentId=${documentId} (published)`);
  } else {
    strapi.log.info(`[DEV_SEED] ${uid}: zh of slug=${slug} exists (documentId=${documentId}), skip`);
  }

  if (enCount === 0) {
    await documents(uid).create({
      data: { documentId, slug, ...en },
      locale: 'en',
      status: 'published',
    });
    strapi.log.info(`[DEV_SEED] ${uid}: created en variant of documentId=${documentId} (published)`);
  } else {
    strapi.log.info(`[DEV_SEED] ${uid}: en of slug=${slug} exists, skip`);
  }
}

/**
 * 幂等确保 locale 集合为 {zh, en} 且默认 zh。
 *
 * 背景：Strapi 5.58 的 i18n 插件不读 plugins.ts 里的 v4 式 defaultLocale/locales
 * 配置；空库的首个 locale 由 STRAPI_PLUGIN_I18N_INIT_LOCALE_CODE 决定（见
 * .env），其余 locale 必须显式创建。这里在每次启动时对齐目标状态，保证任何
 * 环境（本地 sqlite / 生产 Postgres）从空库起都能得到同一套语言配置。
 */
async function ensureLocales(strapi: Strapi): Promise<void> {
  const localesService = strapi.plugin('i18n').service('locales') as {
    create: (locale: { code: string; name: string; displayName?: string }) => Promise<unknown>;
    getDefaultLocale: () => Promise<string | undefined>;
    setDefaultLocale: (params: { code: string }) => Promise<unknown>;
  };
  const wanted: Record<string, string> = { zh: 'Chinese (zh)', en: 'English (en)' };

  const existing = (await strapi.query('plugin::i18n.locale').findMany()) as Array<{
    code: string;
  }>;
  const have = new Set(existing.map((l) => l.code));
  for (const [code, name] of Object.entries(wanted)) {
    if (!have.has(code)) {
      await localesService.create({ code, name, displayName: code });
      strapi.log.info(`[i18n] created locale ${code}`);
    }
  }

  const currentDefault = await localesService.getDefaultLocale();
  if (currentDefault !== 'zh') {
    await localesService.setDefaultLocale({ code: 'zh' });
    strapi.log.info(`[i18n] default locale: ${currentDefault ?? '(none)'} -> zh`);
  }
}

export default {
  register(/* { strapi }: { strapi: Strapi } */) {},

  async bootstrap({ strapi }: { strapi: Strapi }) {
    await ensureLocales(strapi);
    if (process.env.DEV_SEED) {
      strapi.log.info('[DEV_SEED] enabled: granting public find + seeding sample content');
      await grantPublicFindPermissions(strapi);
      for (const uid of CONTENT_TYPES) {
        await seedLocalizedPair(strapi, uid);
      }
      strapi.log.info('[DEV_SEED] done');
    }
    if (process.env.MIGRATE_CONTENT) {
      // 一次性内容迁移（任务 3.1，详见 src/migrate-content.ts 与 README）。
      // 动态 import：js-yaml 是 devDependency，只在迁移分支加载，不影响生产启动。
      const { migrateContent } = await import('./migrate-content');
      await migrateContent(strapi);
      if (process.env.MIGRATE_EXIT) {
        strapi.log.info('[MIGRATE_CONTENT] MIGRATE_EXIT=1，导入结束，退出进程');
        process.exit(0);
      }
    }
  },
};
