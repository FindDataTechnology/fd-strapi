#!/usr/bin/env node
// backfill-claims.mjs — 把 canonical md 的 claim 骨架回填进 CMS（xingyan-claim-layer 任务 4.2）
//
// 做什么：读 docs/xingyan/{briefings,academy,research}/{zh,en}/*.md 的
// `claims` 与 `sources`（含 id 引用键），按 slug 找到 CMS 里对应文档，
// 逐 locale 只 PUT 这两个字段，然后重新发布（PUT 会把人文档翻回 modified，
// 必须再 publish 并收敛——2026-10-27 实测坑）。
//
// 只碰 claims / sources 两个字段：正文、标题、排序一概不动。canonical 里没有
// claims 的条目直接跳过（未声明骨架的存量条目不受约束，spec 明确）。
//
// 用法：
//   XINGYAN_ADMIN_PW=... node scripts/backfill-claims.mjs --dry-run
//   XINGYAN_ADMIN_PW=... node scripts/backfill-claims.mjs --apply
//   XINGYAN_ADMIN_PW=... node scripts/backfill-claims.mjs --apply --only law-bench-evaluation-loop
//
// 环境：XINGYAN_CMS（默认 https://cms.finddatatech.cloud）、
//       XINGYAN_CANON（默认 ../docs/xingyan）、
//       XINGYAN_ADMIN_EMAIL（默认 xingyan-admin@finddatatech.cloud）

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BASE = (process.env.XINGYAN_CMS ?? 'https://cms.finddatatech.cloud').replace(/\/+$/, '');
const CANON = resolve(process.env.XINGYAN_CANON ?? join(import.meta.dirname, '..', '..', 'docs', 'xingyan'));
const EMAIL = process.env.XINGYAN_ADMIN_EMAIL ?? 'xingyan-admin@finddatatech.cloud';
const PW = process.env.XINGYAN_ADMIN_PW ?? '';
const LOCALES = ['zh', 'en'];
const ZONES = [
  { dir: 'briefings', uid: 'api::briefing.briefing' },
  { dir: 'academy', uid: 'api::course.course' },
  { dir: 'research', uid: 'api::research-article.research-article' },
];

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DRY = args.includes('--dry-run') || !APPLY;
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

// ── minimal REST ────────────────────────────────────────────────────────────
async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text.slice(0, 400) };
  }
  if (!res.ok) {
    const err = new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
    err.status = res.status;
    err.payload = json;
    throw err;
  }
  return json;
}

// ── canonical parsing (no yaml dep, same shape as ai_readable_check.py) ─────
function splitFm(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  return { fm: m ? m[1] : '', body: m ? text.slice(m[0].length) : text };
}

function blockItems(fm, key) {
  const lines = fm.split('\n');
  const items = [];
  let i = 0;
  while (i < lines.length) {
    if (!new RegExp(`^\\s*${key}:\\s*$`).test(lines[i])) {
      i++;
      continue;
    }
    i++;
    let cur = null;
    while (i < lines.length) {
      const raw = lines[i];
      if (!raw.trim()) {
        i++;
        continue;
      }
      if (!raw.startsWith(' ') && !raw.startsWith('\t')) break;
      const st = raw.trim();
      i++;
      if (st.startsWith('#')) continue;
      const m = st.match(/^-\s*(.*)$/);
      if (m) {
        cur = {};
        items.push(cur);
        const rest = m[1].trim();
        const kv = rest.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
        if (kv) cur[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
        else if (rest) cur.text = rest;
        continue;
      }
      const kv = st.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (kv && cur) cur[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
      else if (cur && cur.text) cur.text = `${cur.text} ${st}`.trim();
    }
  }
  return items;
}

// sources 输出成 CMS 认的形状：有 url/对象的保留对象，纯文本保持字符串
function normalizeSources(items) {
  return items.map((s) => {
    if (!s.id && !s.label && s.text) return s.text;
    const o = {};
    if (s.id) o.id = s.id;
    o.label = s.label ?? s.text ?? '';
    if (s.url) o.url = s.url;
    return o;
  });
}

function readCanonical(zone, locale) {
  const dir = join(CANON, zone, locale);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const slug = name.replace(/\.md$/, '');
    const { fm } = splitFm(readFileSync(join(dir, name), 'utf8'));
    const claims = blockItems(fm, 'claims').filter((c) => c.id);
    const sources = normalizeSources(blockItems(fm, 'sources'));
    if (claims.length === 0) continue; // 未声明骨架：不动
    out.push({
      slug,
      claims: claims.map((c) => ({
        id: c.id,
        section: c.section ?? '',
        type: c.type ?? '',
        evidence: (c.evidence ?? '')
          .replace(/^\[|\]$/g, '')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      })),
      sources,
    });
  }
  return out;
}

// ── main ────────────────────────────────────────────────────────────────────
const STATS = { scanned: 0, matched: 0, missing: [], updated: 0, unchanged: 0, failed: [] };

async function main() {
  if (!PW) throw new Error('需要 XINGYAN_ADMIN_PW 环境变量');
  console.log(`[backfill] CMS=${BASE}  canon=${CANON}  模式=${DRY ? 'DRY-RUN' : 'APPLY'}`);

  const login = await api('/admin/login', { method: 'POST', body: { email: EMAIL, password: PW } });
  const token = login?.data?.token;
  if (!token) throw new Error('登录失败：未拿到 token');

  for (const zone of ZONES) {
    console.log(`\n── ${zone.dir} ──`);
    for (const locale of LOCALES) {
      const entries = readCanonical(zone.dir, locale);
      if (!entries.length) {
        console.log(`  ${locale}: canonical 无 claim 声明，跳过`);
        continue;
      }
      for (const entry of entries) {
        if (ONLY && entry.slug !== ONLY) continue;
        STATS.scanned++;
        // 找文档：按 slug 过滤（locale=* 拿 documentId）
        const q = `/content-manager/collection-types/${zone.uid}?locale=*&filters[$and][0][slug][$eq]=${encodeURIComponent(entry.slug)}&pagination[pageSize]=5`;
        let found;
        try {
          found = await api(q, { token });
        } catch (e) {
          STATS.failed.push(`${zone.dir}/${locale}/${entry.slug}: 查询失败 ${e.message}`);
          continue;
        }
        const rows = found?.results ?? [];
        if (!rows.length) {
          STATS.missing.push(`${zone.dir}/${entry.slug}`);
          console.log(`  ${locale} ${entry.slug}: CMS 无此条目（未上站），跳过`);
          continue;
        }
        const documentId = rows[0].documentId;
        STATS.matched++;

        if (DRY) {
          console.log(
            `  ${locale} ${entry.slug}: 将写 claims=${entry.claims.length} sources=${entry.sources.length} (doc ${documentId.slice(0, 8)}…)`,
          );
          continue;
        }

        try {
          await api(
            `/content-manager/collection-types/${zone.uid}/${documentId}?locale=${locale}`,
            { method: 'PUT', token, body: { claims: entry.claims, sources: entry.sources } },
          );
          await api(
            `/content-manager/collection-types/${zone.uid}/${documentId}/actions/publish?locale=${locale}`,
            { method: 'POST', token, body: {} },
          );
          STATS.updated++;
          console.log(`  ${locale} ${entry.slug}: 已写入 + publish（claims=${entry.claims.length}）`);
        } catch (e) {
          STATS.failed.push(`${zone.dir}/${locale}/${entry.slug}: ${e.message}`);
          console.log(`  ${locale} ${entry.slug}: ✗ ${e.message}`);
        }
      }
    }
  }

  console.log('\n── 汇总 ──');
  console.log(`  扫描条目 ${STATS.scanned} / 命中 CMS ${STATS.matched} / 写入 ${STATS.updated}`);
  if (STATS.missing.length) console.log(`  CMS 无对应条目（未上站）：${STATS.missing.length} 处\n    ${STATS.missing.join('\n    ')}`);
  if (STATS.failed.length) {
    console.log(`  失败 ${STATS.failed.length} 处：\n    ${STATS.failed.join('\n    ')}`);
    process.exitCode = 1;
  }
  if (DRY) console.log('\n（DRY-RUN：未写入任何内容；加 --apply 执行）');
}

main().catch((e) => {
  console.error(`[backfill] 失败：${e.message}`);
  process.exit(1);
});
