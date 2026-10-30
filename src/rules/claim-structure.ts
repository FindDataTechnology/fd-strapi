// claim 骨架发布闸（OpenSpec xingyan-claim-layer 任务 1.5）
//
// 与内部标识闸（internal-identifiers.ts / publish-guard.ts）是**同一发布位的第二道
// 检查**，职责不同：标识闸管「这段话会不会泄露内部坐标」，本闸管「这条断言有没有
// 锚、有没有证据」。为什么要在 CMS 侧再查一遍：canonical 的机检在 fd-strapi 之外，
// 而 admin 后台可以绕过 canonical 直接录入并发布——不在这里拦，claim 契约对「直录
// 路径」就是一句空话（对齐 design D3 的「双发布位」）。
//
// 镜像范围（刻意收窄，避免与 canonical 重复造判定）：
//   ① 四要素 + ID 格式 + type 枚举
//   ③ evidence 解析到带 id 的来源条目（闭环）
//   ④ 双语 claim ID 集合与类型一致
// 不镜像的：⑤ 强断言正则覆盖。理由：那要读正文散文并做语言判定，canonical 已验；
// CMS 侧再实现一套必然二次维护、且两处判定分叉时无法说清谁对。
//
// 语义与 truth 源：docs/xingyan/scripts/ai_readable_check.py（check_claims）。
// 本模块只依赖纯逻辑，不 import strapi —— 便于单测与在无框架环境下复用。

export const CLAIM_ID_RE = /^c\d{4}$/;
export const SOURCE_ID_RE = /^src-\d+$/;
export const CLAIM_TYPES = ['number', 'causal', 'promise'] as const;

export type ClaimIssue = {
  /** 规整后的规则名，与 canonical 机检的 F 编号对齐，便于两边对账 */
  rule: string;
  message: string;
};

type AnyRecord = Record<string, unknown>;

function asArray(value: unknown): AnyRecord[] {
  return Array.isArray(value) ? (value.filter((v) => v && typeof v === 'object') as AnyRecord[]) : [];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 单条目的 claim 骨架检查（四要素 / 格式 / 枚举 / 证据闭环）。 */
export function checkClaims(claimsRaw: unknown, sourcesRaw: unknown): ClaimIssue[] {
  const claims = asArray(claimsRaw);
  const sources = Array.isArray(sourcesRaw) ? sourcesRaw : [];
  const issues: ClaimIssue[] = [];

  // 来源引用键：格式与唯一性。纯文本来源（字符串）不参与，存量条目因此不受影响。
  const sourceIds = new Map<string, number>();
  for (const s of sources) {
    if (typeof s === 'string') continue;
    if (!s || typeof s !== 'object') continue;
    const id = str((s as AnyRecord).id);
    if (!id) continue;
    if (!SOURCE_ID_RE.test(id)) {
      issues.push({ rule: 'F0-来源键格式', message: `来源 id「${id}」不合规（须形如 src-1）` });
    }
    const seen = sourceIds.get(id) ?? 0;
    if (seen > 0) {
      issues.push({ rule: 'F0-来源键重复', message: `来源 id「${id}」重复` });
    }
    sourceIds.set(id, seen + 1);
  }

  // 未声明骨架：不阻断（spec：存量条目兼容；修订发布时补齐）。
  if (claims.length === 0) return issues;

  const seenClaimIds = new Map<string, number>();
  for (const c of claims) {
    const id = str(c.id);
    const section = str(c.section);
    const type = str(c.type);
    const evidenceRaw = c.evidence;
    const evidence = Array.isArray(evidenceRaw) ? evidenceRaw.map((e) => str(e)).filter(Boolean) : [];

    const missing = [
      !id ? 'id' : null,
      !section ? 'section' : null,
      !type ? 'type' : null,
      evidence.length === 0 ? 'evidence' : null,
    ].filter(Boolean);
    if (missing.length) {
      issues.push({
        rule: 'F1-claim缺要素',
        message: `claim「${id || '无 id'}」缺 ${missing.join('、')}`,
      });
      continue;
    }

    if (!CLAIM_ID_RE.test(id)) {
      issues.push({ rule: 'F1-claimID格式', message: `claim id「${id}」不合规（须形如 c0001）` });
    }
    const count = seenClaimIds.get(id) ?? 0;
    if (count > 0) {
      issues.push({ rule: 'F1-claimID重复', message: `claim id「${id}」在本条目内重复` });
    }
    seenClaimIds.set(id, count + 1);

    if (!(CLAIM_TYPES as readonly string[]).includes(type)) {
      issues.push({
        rule: 'F1-claim类型',
        message: `claim「${id}」的 type「${type}」不在枚举 ${CLAIM_TYPES.join('/')} 内`,
      });
    }

    for (const ev of evidence) {
      if (!sourceIds.has(ev)) {
        issues.push({
          rule: 'F3-证据悬空',
          message: `claim「${id}」的 evidence「${ev}」解析不到带 id 的来源条目`,
        });
      }
    }
  }

  return issues;
}

/** 双语一致性：同一 documentId 的各 locale 行必须声明相同的 claim ID 集合与类型。 */
export function checkClaimsAcrossLocales(
  rows: Array<{ locale?: unknown; claims?: unknown }>
): ClaimIssue[] {
  const byLocale = new Map<string, Map<string, string>>(); // locale → (claimId → type)
  for (const row of rows) {
    const locale = str(row.locale) || '默认';
    const map = new Map<string, string>();
    for (const c of asArray(row.claims)) {
      const id = str(c.id);
      if (id) map.set(id, str(c.type));
    }
    if (map.size || !byLocale.has(locale)) byLocale.set(locale, map);
  }

  const locales = [...byLocale.keys()];
  if (locales.length < 2) return []; // 只有一侧存在时不判（双胞胎门在官网构建期）

  const issues: ClaimIssue[] = [];
  const base = locales[0];
  const baseMap = byLocale.get(base)!;
  for (const other of locales.slice(1)) {
    const otherMap = byLocale.get(other)!;
    const onlyBase = [...baseMap.keys()].filter((id) => !otherMap.has(id));
    const onlyOther = [...otherMap.keys()].filter((id) => !baseMap.has(id));
    if (onlyBase.length || onlyOther.length) {
      issues.push({
        rule: 'F5-双语不同构',
        message:
          `claim ID 集合不一致：${base} 独有 ${onlyBase.length ? onlyBase.join(',') : '无'}，` +
          `${other} 独有 ${onlyOther.length ? onlyOther.join(',') : '无'}`,
      });
      continue;
    }
    for (const [id, type] of baseMap) {
      const otherType = otherMap.get(id);
      if (otherType !== type) {
        issues.push({
          rule: 'F5-双语类型不一致',
          message: `claim「${id}」类型不一致：${base}=${type}，${other}=${otherType}`,
        });
      }
    }
  }
  return issues;
}

/** 把一批问题拼成给 admin 看的一行报文（含处置指引）。 */
export function formatClaimIssues(issues: ClaimIssue[], slug: string, locale: string): string {
  const MAX = 5;
  const shown = issues.slice(0, MAX).map((i) => `【${i.rule}】「${slug}」(${locale}) ${i.message}`).join('；');
  const more = issues.length > MAX ? `；…等共 ${issues.length} 处` : '';
  return (
    `发布被拦截：claim 骨架不合规。命中 ${issues.length} 处：${shown}${more}。` +
    `请补齐 id/section/type/evidence，或让 evidence 指向 sources 里带 id 的条目；` +
    `双语两侧的 claim ID 集合与类型必须一致。规则真源：docs/xingyan/scripts/ai_readable_check.py。`
  );
}
