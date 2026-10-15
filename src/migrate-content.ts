// 一次性内容迁移（OpenSpec `strapi-content-publishing` 任务 3.1）：
// 把官网仓 fd-official-web 的 16 个 md（8 个文档 × zh/en）导入 Strapi，
// 产物与源文件逐字节等价（官网拉取脚本 fetch-strapi.mjs 回写后 git diff=0，
// 即 design.md D8 的切换判据）。
//
// 触发方式（详见 README「内容导入」）：
//   MIGRATE_CONTENT=1 [MIGRATE_EXIT=1] [MIGRATE_SRC=<md根>] npm run develop
//   npm run content:import -- --src <md根> [--force]
//
// 机制（v5.58 实测事实，与 src/index.ts 的 DEV_SEED 同一套）：
//  - 在 Strapi 进程内走 document service，先建 zh（默认 locale、published），
//    再在 data 里带 zh 的 documentId 建 en 变体（data.documentId 会透传，但
//    不会自动复制非本地化字段——slug/date/kind/order/pack_url 必须显式给全）。
//  - 幂等：按 (slug, locale) 判存在，已存在则跳过；--force 先删两语言再重建。
//  - 共享字段（slug 取自文件名；date/kind/order/pack_url 取自 frontmatter）
//    在 zh/en 两个文件中必须一致，否则报错拒导（对齐官网拉取侧的同组 slug
//    一致性预检）。
//
// js-yaml 是生产依赖（容器内一次性导入 content:import:prebuilt 也要用）：
// 本模块仍经 src/index.ts 的 MIGRATE_CONTENT 分支动态 import，正常启动不加载。

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

type Strapi = import('@strapi/strapi').Core.Strapi;

/** md 集合目录名 → 内容类型 uid + 字段分组 */
const COLLECTIONS: ReadonlyArray<{
  dir: string;
  uid: string;
  kind: 'briefing' | 'course' | 'research';
}> = [
  { dir: 'briefings', uid: 'api::briefing.briefing', kind: 'briefing' },
  { dir: 'academy', uid: 'api::course.course', kind: 'course' },
  { dir: 'research', uid: 'api::research-article.research-article', kind: 'research' },
];

const LOCALES = ['zh', 'en'] as const;
type Locale = (typeof LOCALES)[number];

/** 随语言变的字段（zh/en 各自从各自文件取值） */
const LOCALIZED_FIELDS: Record<string, readonly string[]> = {
  briefing: ['title', 'summary', 'tags', 'sources', 'body'],
  course: ['title', 'summary', 'source_material', 'body'],
  research: ['title', 'summary', 'tags', 'sources', 'body'],
};

/** 双语共享字段（frontmatter 层面，两语言必须同值；slug 本身取自文件名） */
const SHARED_FIELDS: Record<string, readonly string[]> = {
  briefing: ['date'],
  course: ['order', 'pack_url'],
  research: ['date', 'kind'],
};

/** 各类型必填的 frontmatter 键（除 slug 外） */
const REQUIRED_FM: Record<string, readonly string[]> = {
  briefing: ['title', 'summary', 'date', 'tags', 'sources'],
  course: ['title', 'summary', 'source_material'],
  research: ['title', 'summary', 'date', 'kind', 'tags', 'sources'],
};

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = ['paper', 'casestudy', 'note'] as const;

type Frontmatter = Record<string, unknown>;

interface MdEntry {
  slug: string;
  fm: Frontmatter;
  body: string;
}

export interface MigrateStats {
  perCollection: Array<{ dir: string; files: number; created: number; skipped: number }>;
  totalCreated: number;
  totalSkipped: number;
}

class MigrationError extends Error {}

function fail(file: string, msg: string): never {
  throw new MigrationError(`${file}: ${msg}`);
}

/** 解析 frontmatter markdown：--- 围栏 + 空行 + 正文。正文做与官网拉取侧写盘一致的尾部规范化。 */
function parseMarkdown(file: string): { fm: Frontmatter; body: string } {
  const raw = fs.readFileSync(file, 'utf8');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n\n([\s\S]*)$/.exec(raw);
  if (!m) fail(file, '不是合法的 frontmatter markdown（应为 "---\\n<fm>\\n---\\n\\n<正文>"）');
  let fm: unknown;
  try {
    fm = yaml.load(m[1]);
  } catch (err) {
    fail(file, `frontmatter YAML 解析失败：${(err as Error).message}`);
  }
  if (!fm || typeof fm !== 'object' || Array.isArray(fm)) fail(file, 'frontmatter 不是 YAML 映射');
  // 与 fetch-strapi.mjs 写盘时对正文的处理完全一致：去尾空行 + 单个换行。
  const body = m[2].replace(/\n+$/, '') + '\n';
  return { fm: fm as Frontmatter, body };
}

function requireNonEmptyString(fm: Frontmatter, key: string, file: string): string {
  const v = fm[key];
  if (typeof v !== 'string' || v.trim() === '') fail(file, `frontmatter 缺必填字符串字段 ${key}`);
  return v;
}

function normalizeDate(v: unknown, file: string): string {
  // js-yaml 的 YAML-1.1 schema 会把裸日期解析成 Date；围栏内带引号时是 string。
  const s = v instanceof Date ? v.toISOString().slice(0, 10) : v;
  if (typeof s !== 'string' || !DATE_RE.test(s)) fail(file, `date "${String(s)}" 不是 YYYY-MM-DD`);
  return s;
}

function requireStringArray(fm: Frontmatter, key: string, file: string): string[] {
  const v = fm[key];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x === '')) {
    fail(file, `${key} 必须是非空字符串组成的数组`);
  }
  return v as string[];
}

/** 校验单个文件的 frontmatter，返回导入载荷（含 slug；不含 body，由调用方拼）。 */
function validateEntry(kind: string, file: string, fm: Frontmatter): Frontmatter {
  const out: Frontmatter = {};
  for (const key of REQUIRED_FM[kind]) {
    if (!(key in fm)) fail(file, `frontmatter 缺必填字段 ${key}`);
  }
  out.title = requireNonEmptyString(fm, 'title', file);
  out.summary = requireNonEmptyString(fm, 'summary', file);
  if (kind === 'briefing') {
    out.date = normalizeDate(fm.date, file);
    out.tags = requireStringArray(fm, 'tags', file);
    out.sources = requireStringArray(fm, 'sources', file);
  } else if (kind === 'course') {
    const order = fm.order ?? 10;
    if (typeof order !== 'number' || !Number.isInteger(order)) fail(file, `order "${String(order)}" 不是整数`);
    out.order = order;
    const pack = fm.pack_url ?? '';
    if (typeof pack !== 'string') fail(file, 'pack_url 不是字符串');
    out.pack_url = pack;
    out.source_material = requireNonEmptyString(fm, 'source_material', file);
  } else {
    out.date = normalizeDate(fm.date, file);
    if (typeof fm.kind !== 'string' || !(KINDS as readonly string[]).includes(fm.kind)) {
      fail(file, `kind "${String(fm.kind)}" 不在 ${KINDS.join('/')} 内`);
    }
    out.kind = fm.kind;
    out.tags = requireStringArray(fm, 'tags', file);
    out.sources = requireStringArray(fm, 'sources', file);
  }
  return out;
}

function readLocaleDir(srcRoot: string, dir: string, locale: Locale, kind: string): Map<string, MdEntry> {
  const abs = path.join(srcRoot, dir, locale);
  let names: string[];
  try {
    names = fs.readdirSync(abs);
  } catch (err) {
    throw new MigrationError(`读目录 ${abs} 失败：${(err as Error).message}`);
  }
  const bySlug = new Map<string, MdEntry>();
  for (const name of names.filter((n) => n.endsWith('.md')).sort()) {
    const slug = name.slice(0, -3);
    if (!SLUG_RE.test(slug)) fail(path.join(abs, name), `文件名派生的 slug "${slug}" 不合法`);
    const file = path.join(abs, name);
    const { fm, body } = parseMarkdown(file);
    if (!body.trim()) fail(file, '正文为空');
    bySlug.set(slug, { slug, fm: validateEntry(kind, file, fm), body });
  }
  return bySlug;
}

/** 组装 documents().create 的 data：slug + 共享字段 + 本地化字段 + body。en/zh 变体创建时都必须带全。 */
function buildPayload(kind: string, entry: MdEntry): Record<string, unknown> {
  return { slug: entry.slug, ...entry.fm, body: entry.body };
}

export async function migrateContent(strapi: Strapi): Promise<MigrateStats> {
  // npm 透传的 CLI 参数优先，其次 MIGRATE_SRC 环境变量。
  const argv = process.argv;
  const srcIdx = argv.indexOf('--src');
  const srcRoot = srcIdx >= 0 ? argv[srcIdx + 1] : process.env.MIGRATE_SRC;
  const force = argv.includes('--force') || process.env.MIGRATE_FORCE === '1';
  if (!srcRoot) {
    throw new MigrationError(
      'MIGRATE_CONTENT=1 需要 --src <md根目录>（或 MIGRATE_SRC），例如 npm run content:import -- --src ../fd-official-web/src/content'
    );
  }
  if (!fs.existsSync(srcRoot)) throw new MigrationError(`--src 目录不存在：${srcRoot}`);

  // strapi.documents() 的 TS 签名按内容类型字面量生成，string uid 过不了泛型；
  // 迁移按 uid 动态分发，放宽为运行时等价门面（同 src/index.ts DEV_SEED 的做法）。
  const documents = strapi.documents as unknown as (uid: string) => {
    create: (params: Record<string, unknown>) => Promise<{ documentId: string }>;
    delete: (params: Record<string, unknown>) => Promise<unknown>;
  };

  const stats: MigrateStats = { perCollection: [], totalCreated: 0, totalSkipped: 0 };
  strapi.log.info(`[MIGRATE_CONTENT] 开始：src=${srcRoot} force=${force}`);

  for (const col of COLLECTIONS) {
    const perLocale = {} as Record<Locale, Map<string, MdEntry>>;
    for (const locale of LOCALES) perLocale[locale] = readLocaleDir(srcRoot, col.dir, locale, col.kind);

    // 成对与共享字段一致性预检（zh/en 都要有，且共享字段同值）。
    for (const slug of perLocale.zh.keys()) {
      if (!perLocale.en.has(slug)) {
        throw new MigrationError(`${col.dir}: slug=${slug} 只有 zh 没有 en（双语必须成对）`);
      }
    }
    for (const slug of perLocale.en.keys()) {
      if (!perLocale.zh.has(slug)) {
        throw new MigrationError(`${col.dir}: slug=${slug} 只有 en 没有 zh（双语必须成对）`);
      }
    }
    for (const [slug, zhEntry] of perLocale.zh) {
      const enEntry = perLocale.en.get(slug)!;
      for (const field of SHARED_FIELDS[col.kind]) {
        if (String(zhEntry.fm[field]) !== String(enEntry.fm[field])) {
          throw new MigrationError(
            `${col.dir}/${slug}.md：共享字段 ${field} 在 zh/en 两语言不一致（` +
              `${String(zhEntry.fm[field])} vs ${String(enEntry.fm[field])}），拒绝导入`
          );
        }
      }
    }

    let created = 0;
    let skipped = 0;

    for (const [slug, zhEntry] of [...perLocale.zh.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const enEntry = perLocale.en.get(slug)!;

      if (force) {
        const anyRow = await strapi.db.query(col.uid).findOne({ where: { slug } });
        if (anyRow?.documentId) {
          for (const locale of LOCALES) {
            try {
              await documents(col.uid).delete({ documentId: anyRow.documentId, locale });
            } catch {
              /* 该 locale 无变体时忽略 */
            }
          }
          strapi.log.info(`[MIGRATE_CONTENT] ${col.dir}/${slug}: --force 已删除旧文档 documentId=${anyRow.documentId}`);
        }
      }

      const rows = await strapi.db.query(col.uid).findMany({
        where: { slug, locale: LOCALES },
        select: ['documentId', 'locale', 'publishedAt'],
      });
      const existing = new Map(
        (rows as Array<{ documentId: string; locale: string }>).map((r) => [r.locale, r.documentId])
      );

      if (existing.has('zh') && existing.has('en')) {
        skipped += 2;
        strapi.log.info(
          `[MIGRATE_CONTENT] ${col.dir}/${slug}: zh+en 均已存在（documentId=${existing.get('zh')}），跳过`
        );
        continue;
      }

      // 以已存在变体的 documentId 为锚（正常流程是 zh 先建；崩溃恢复时可能只剩 en）。
      let documentId = existing.get('zh') ?? existing.get('en');
      if (!existing.has('zh')) {
        const zhData = documentId ? { documentId, ...buildPayload(col.kind, zhEntry) } : buildPayload(col.kind, zhEntry);
        const made = await documents(col.uid).create({ data: zhData, locale: 'zh', status: 'published' });
        documentId = made.documentId;
        created++;
        strapi.log.info(`[MIGRATE_CONTENT] ${col.dir}/${slug}: 建 zh（published，documentId=${documentId}）`);
      }
      if (!existing.has('en')) {
        await documents(col.uid).create({
          data: { documentId: documentId!, ...buildPayload(col.kind, enEntry) },
          locale: 'en',
          status: 'published',
        });
        created++;
        strapi.log.info(`[MIGRATE_CONTENT] ${col.dir}/${slug}: 建 en 变体（published，documentId=${documentId}）`);
      }
    }

    const files = perLocale.zh.size + perLocale.en.size;
    stats.perCollection.push({ dir: col.dir, files, created, skipped });
    stats.totalCreated += created;
    stats.totalSkipped += skipped;
    strapi.log.info(`[MIGRATE_CONTENT] ${col.dir}: 源 ${files} 个 md，新建 ${created} 条，跳过 ${skipped} 条`);
  }

  strapi.log.info(
    `[MIGRATE_CONTENT] 完成：共新建 ${stats.totalCreated} 条、跳过 ${stats.totalSkipped} 条` +
      `（${stats.perCollection.map((s) => `${s.dir} ${s.created}/${s.files}`).join('，')}）`
  );
  return stats;
}
