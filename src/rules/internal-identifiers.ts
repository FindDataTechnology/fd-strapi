// 内部标识规则清单——解析与匹配（纯逻辑，无 strapi 依赖）。
//
// 规则清单的唯一事实源是 finddata 工作区的
//   docs/xingyan/scripts/internal-identifiers.txt
// fd-strapi 内的打包副本 src/rules/internal-identifiers.txt 由
// `npm run rules:sync`（scripts/sync-rules.mjs）生成，运行时只读本模块
// 的解析结果。清单格式与语义对齐参照实现
//   docs/xingyan/scripts/sanitize_check.py（同工作区）：
//   - `#` 开头的行为注释，空行跳过；
//   - 规则行：`<类别> | <字面串 或 /正则/>`（首个 `|` 分隔，两端去空白）；
//   - 字面串大小写不敏感；正则以 `/` 包裹，大小写不敏感编译；
//   - 解析失败（缺 `|`、类别/模式为空、正则编译不过）视为清单损坏，
//     连同「文件缺失 / 清单为空」一律 fail-closed（见 publish-guard.ts）。
//
// 注意：正则语法以 Python re 与 JS RegExp 的公共子集为准（现有清单中的
// 模式全部落在该子集内）；新规则若用了 Perl/Python 专有语法，会在解析
// 时报错并 fail-closed，不会静默漏检。

import fs from 'fs';
import path from 'path';

/** 一条可执行规则：分类名 + 原始模式文本 + 编译后的正则 */
export type Rule = {
  category: string;
  pattern: string;
  regex: RegExp;
};

/** 清单加载结果：ok=false 时 reason 给出 fail-closed 的人话原因 */
export type LoadedRules =
  | { ok: true; rules: Rule[]; path: string }
  | { ok: false; reason: string; path: string };

/** 一处命中：分类 + 条目字段路径 + 命中附近的片段 */
export type FieldHit = {
  category: string;
  pattern: string;
  field: string;
  snippet: string;
};

/** 打包副本的候选路径（按序尝试第一个存在的） */
export function candidateRulePaths(): string[] {
  const cwd = process.cwd();
  return [
    // 常规：仓库内的 src 副本（develop 与部署目录都成立）
    path.join(cwd, 'src', 'rules', 'internal-identifiers.txt'),
    // 打包场景：副本与本模块同目录（若未来构建把 src/rules 拷进 dist）
    path.join(__dirname, 'internal-identifiers.txt'),
    // 兜底：dist 镜像位置
    path.join(cwd, 'dist', 'src', 'rules', 'internal-identifiers.txt'),
  ];
}

/** 把一行清单文本编译为规则；失败返回错误消息（不含路径前缀） */
function compileRuleLine(line: string): { rule: Rule } | { error: string } {
  const bar = line.indexOf('|');
  if (bar < 0) return { error: `规则行缺少 '|' 分隔：${line}` };
  const category = line.slice(0, bar).trim();
  const pattern = line.slice(bar + 1).trim();
  if (!category || !pattern) {
    return { error: `规则的类别或模式为空：${line}` };
  }
  let regex: RegExp;
  if (pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
    try {
      regex = new RegExp(pattern.slice(1, -1), 'i');
    } catch (e) {
      return { error: `正则无法编译（${e instanceof Error ? e.message : String(e)}）：${pattern}` };
    }
  } else {
    regex = new RegExp(escapeRegExp(pattern), 'i');
  }
  return { rule: { category, pattern, regex } };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 解析清单文本（不含文件 IO），供加载与自检复用。
 * 规则数为 0 时返回 ok=false（fail-closed：空清单等于门失效）。
 */
export function parseRulesContent(content: string): { rules: Rule[] } | { error: string } {
  const rules: Rule[] = [];
  const lines = content.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const compiled = compileRuleLine(line);
    if ('error' in compiled) {
      return { error: `第 ${i + 1} 行：${compiled.error}` };
    }
    rules.push(compiled.rule);
  }
  if (rules.length === 0) {
    return { error: '规则清单为空（没有任何有效规则行）' };
  }
  return { rules };
}

/** 读取并解析打包副本；文件缺失 / 为空 / 损坏均返回 ok=false */
export function loadPackedRules(): LoadedRules {
  const candidates = candidateRulePaths();
  const existing = candidates.find((p) => fs.existsSync(p));
  if (!existing) {
    return {
      ok: false,
      path: candidates[0],
      reason: `规则清单缺失（尝试过：${candidates.join('、')}）`,
    };
  }
  let content: string;
  try {
    content = fs.readFileSync(existing, 'utf8');
  } catch (e) {
    return {
      ok: false,
      path: existing,
      reason: `规则清单读取失败：${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const parsed = parseRulesContent(content);
  if ('error' in parsed) {
    return { ok: false, path: existing, reason: `规则清单无效：${parsed.error}` };
  }
  return { ok: true, rules: parsed.rules, path: existing };
}

/** 对单段文本逐条规则匹配，返回全部命中的（分类, 模式, 首个命中片段） */
export function scanText(text: string, rules: Rule[]): Array<{ category: string; pattern: string; snippet: string }> {
  const hits: Array<{ category: string; pattern: string; snippet: string }> = [];
  for (const rule of rules) {
    const m = rule.regex.exec(text);
    if (m) {
      hits.push({ category: rule.category, pattern: rule.pattern, snippet: snippetAround(text, m.index) });
    }
  }
  return hits;
}

/** 命中点前后各 ~40 字符的单行片段，供研究员定位改写 */
function snippetAround(text: string, index: number, radius = 40): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  let snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) snippet = '…' + snippet;
  if (end < text.length) snippet = snippet + '…';
  if (snippet.length > 120) snippet = snippet.slice(0, 120) + '…';
  return snippet;
}

/**
 * 扫描一个条目（DB 行或 document service 的 data 载荷）的全部文本面：
 * 所有顶层字符串字段 + 字符串数组（tags/sources 等，命中标注 `字段[i]`）。
 * 每对（规则 × 字段）报告一处（取首个命中片段）。
 */
export function scanEntry(entry: unknown, rules: Rule[]): FieldHit[] {
  const hits: FieldHit[] = [];
  walk(entry, '', (fieldPath, text) => {
    for (const hit of scanText(text, rules)) {
      hits.push({ category: hit.category, pattern: hit.pattern, field: fieldPath, snippet: hit.snippet });
    }
  });
  return hits;
}

/** 深度优先收集对象里的字符串叶子；数组下标进字段路径；忽略函数/循环引用 */
function walk(value: unknown, prefix: string, visit: (fieldPath: string, text: string) => void): void {
  if (typeof value === 'string') {
    visit(prefix || '(值)', value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      const p = prefix ? `${prefix}[${i}]` : `[${i}]`;
      if (typeof item === 'string') visit(p, item);
      else if (item && typeof item === 'object') walk(item, p, visit);
    });
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const p = prefix ? `${prefix}.${key}` : key;
      walk(v, p, visit);
    }
  }
}
