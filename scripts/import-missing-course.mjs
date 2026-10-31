#!/usr/bin/env node
// import-missing-course.mjs — 把仓内快照里有、CMS 里缺失的课程补进 CMS（含双语 + 发布）
//
// 为什么需要这个脚本：生产官网部署线（/opt/fd/fd-web-deploy.sh）早就是
// 「构建期从 CMS 拉取」的真源模式（STRAPI_URL 在 /opt/fd/fd-web-build.env）。
// 仓内快照里有而 CMS 里没有的课程，会在下一次 CMS 触发的部署里被删除——
// 2026-10-31 实测：law-bench 回填触发部署，yizuo-machines-deploy-manage 从线上消失。
// 所以两侧条目集合必须对齐，本脚本负责把「仓内有、CMS 无」的方向补齐。
//
// 用法：
//   XINGYAN_ADMIN_PW=... node scripts/import-missing-course.mjs --slug yizuo-machines-deploy-manage --dry-run
//   XINGYAN_ADMIN_PW=... node scripts/import-missing-course.mjs --slug yizuo-machines-deploy-manage --apply
//
// 环境：XINGYAN_CMS（默认 https://cms.finddatatech.cloud）、XINGYAN_WEB（默认
//       ../fd-official-web，读 src/content/academy/<locale>/<slug>.md）

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BASE = (process.env.XINGYAN_CMS ?? 'https://cms.finddatatech.cloud').replace(/\/+$/, '');
const WEB = resolve(process.env.XINGYAN_WEB ?? join(import.meta.dirname, '..', '..', 'fd-official-web'));
const EMAIL = process.env.XINGYAN_ADMIN_EMAIL ?? 'xingyan-admin@finddatatech.cloud';
const PW = process.env.XINGYAN_ADMIN_PW ?? '';
const UID = 'api::course.course';
const LOCALES = ['zh', 'en'];

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const SLUG = args.includes('--slug') ? args[args.indexOf('--slug') + 1] : '';
if (!SLUG) {
  console.error('需要 --slug <课程 slug>');
  process.exit(2);
}

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return json;
}

function splitFm(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  return { fm: m ? m[1] : '', body: m ? text.slice(m[0].length) : text };
}

function scalar(fm, key) {
  const m = fm.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
  if (!m) return '';
  return m[1].trim().replace(/^["']|["']$/g, '');
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

function readLocale(locale) {
  const p = join(WEB, 'src/content/academy', locale, `${SLUG}.md`);
  if (!existsSync(p)) throw new Error(`找不到 ${p}`);
  const { fm, body } = splitFm(readFileSync(p, 'utf8'));
  return {
    slug: SLUG,
    title: scalar(fm, 'title'),
    summary: scalar(fm, 'summary'),
    order: Number(scalar(fm, 'order') || 10),
    level: scalar(fm, 'level') || undefined,
    updated: scalar(fm, 'updated') || undefined,
    source_material: scalar(fm, 'source_material'),
    pack_url: scalar(fm, 'pack_url'),
    claims: blockItems(fm, 'claims').length
      ? blockItems(fm, 'claims').map((c) => ({
          id: c.id,
          section: c.section ?? '',
          type: c.type ?? '',
          evidence: (c.evidence ?? '').replace(/^\[|\]$/g, '').split(',').map((x) => x.trim()).filter(Boolean),
        }))
      : [],
    body: body.replace(/^\n+/, ''),
  };
}

async function main() {
  if (!PW) throw new Error('需要 XINGYAN_ADMIN_PW');
  console.log(`[import] CMS=${BASE}  web=${WEB}  slug=${SLUG}  模式=${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  const cacheFile = '/tmp/.fd_strapi_tok';
  let token = existsSync(cacheFile) ? readFileSync(cacheFile, 'utf8').trim() : '';
  if (!token) {
    const login = await api('/admin/login', { method: 'POST', body: { email: EMAIL, password: PW } });
    token = login?.data?.token ?? '';
    if (!token) throw new Error('登录失败');
  }

  // upsert：已存在则复用其 documentId 走 PUT+publish（自愈半成品：
  // 例如上次创建成功但 publish 因缺 slug 失败，重跑即可补齐）
  const q = `/content-manager/collection-types/${UID}?locale=*&filters[slug][$eq]=${encodeURIComponent(SLUG)}&pagination[pageSize]=5`;
  const existing = await api(q, { token });
  const found = existing.results ?? [];
  let documentId = found[0]?.documentId ?? '';
  if (documentId) console.log(`  CMS 已有该 slug（doc ${documentId.slice(0, 10)}…）——走更新路径`);
  for (const locale of LOCALES) {
    const data = readLocale(locale);
    console.log(
      `  ${locale}: title=${data.title.slice(0, 30)}… order=${data.order} level=${data.level} body=${data.body.length}B claims=${data.claims.length}`,
    );
    if (!APPLY) continue;

    const payload = { ...data };
    if (documentId) payload.documentId = documentId; // en 变体必须挂在同一 documentId 下
    if (documentId) {
      await api(`/content-manager/collection-types/${UID}/${documentId}?locale=${locale}`, {
        method: 'PUT',
        token,
        body: payload,
      });
    } else {
      const created = await api(`/content-manager/collection-types/${UID}?locale=${locale}`, {
        method: 'POST',
        token,
        body: payload,
      });
      documentId = created?.data?.documentId ?? '';
    }
    if (!documentId) throw new Error(`${locale}: 创建后拿不到 documentId`);
    await api(`/content-manager/collection-types/${UID}/${documentId}/actions/publish?locale=${locale}`, {
      method: 'POST',
      token,
      body: {},
    });
    console.log(`  ${locale}: 已创建 + publish（doc ${documentId.slice(0, 10)}…）`);
  }

  if (!APPLY) {
    console.log('\n（DRY-RUN：未写入；加 --apply 执行）');
    return;
  }

  // 收敛校验：逐 locale 读回 status
  for (const locale of LOCALES) {
    const row = await api(
      `/content-manager/collection-types/${UID}/${documentId}?locale=${locale}`,
      { token },
    );
    console.log(`  校验 ${locale}: status=${row?.data?.status} slug=${row?.data?.slug}`);
  }
}

main().catch((e) => {
  console.error(`[import] 失败：${e.message}`);
  process.exit(1);
});
