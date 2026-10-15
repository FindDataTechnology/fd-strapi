#!/usr/bin/env node
// 规则清单同步：finddata 事实源 → fd-strapi 打包副本（OpenSpec strapi-content-publishing 任务 2.2）。
//
// 用法：
//   npm run rules:sync                      # 从默认事实源同步
//   FD_RULES_SRC=/path/to/internal-identifiers.txt npm run rules:sync   # 覆盖源路径
//
// 默认事实源：<fd-strapi 上级目录>/docs/xingyan/scripts/internal-identifiers.txt
// （即 finddata 工作区的 docs/xingyan/scripts/internal-identifiers.txt）。
// 产物：src/rules/internal-identifiers.txt（头部带生成时间与来源注释；运行时由
// src/rules/internal-identifiers.ts 读取解析）。npm run build 已前置本脚本。
//
// 同步前会按运行时同一套语义校验源文件（注释/空行跳过、`类别 | 模式` 行、
// 正则可编译、清单非空），坏行直接失败退出，绝不生成会让发布拦截失效的副本。

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const cwd = process.cwd();
const SRC = process.env.FD_RULES_SRC
  ? path.resolve(process.env.FD_RULES_SRC)
  : path.resolve(cwd, '..', 'docs', 'xingyan', 'scripts', 'internal-identifiers.txt');
const DEST = path.resolve(cwd, 'src', 'rules', 'internal-identifiers.txt');

function fail(msg) {
  console.error(`rules:sync 失败：${msg}`);
  process.exit(1);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 与 src/rules/internal-identifiers.ts 的 parseRulesContent 同语义的校验 */
function validate(content, file) {
  const lines = content.split(/\r\n|\r|\n/);
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const bar = line.indexOf('|');
    if (bar < 0) fail(`${file}:${i + 1}: 规则行缺少 '|' 分隔：${line}`);
    const category = line.slice(0, bar).trim();
    const pattern = line.slice(bar + 1).trim();
    if (!category || !pattern) fail(`${file}:${i + 1}: 规则的类别或模式为空：${line}`);
    if (pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
      try {
        new RegExp(pattern.slice(1, -1), 'i');
      } catch (e) {
        fail(`${file}:${i + 1}: 正则无法编译（${e.message}）：${pattern}`);
      }
    } else {
      new RegExp(escapeRegExp(pattern), 'i');
    }
    count++;
  }
  if (count === 0) fail(`${file}: 规则清单为空——fail-closed 拒绝生成空清单副本（空清单会让发布拦截失效）`);
  return count;
}

if (!existsSync(SRC)) {
  fail(`事实源不存在：${SRC}（可用 FD_RULES_SRC 覆盖源路径）`);
}
const content = readFileSync(SRC, 'utf8');
const ruleCount = validate(content, SRC);

const header = [
  '# ===========================================================================',
  '# 本文件由 npm run rules:sync 自动生成——勿手改（手改会在下次同步时被覆盖）。',
  '# 规则唯一事实源：' + SRC,
  '# 改规则请改事实源，然后在 fd-strapi 重跑 npm run rules:sync（build 也会自动先跑）。',
  '# 生成时间：' + new Date().toISOString(),
  '# 说明：本副本仅随 fd-strapi 服务端使用，不进入任何对外产物（清单本身不外发）。',
  '# ---- 以下为事实源原文（含其自身注释） ----',
  '',
].join('\n');

mkdirSync(path.dirname(DEST), { recursive: true });
writeFileSync(DEST, header + content, 'utf8');
console.log(`rules:sync 完成：${ruleCount} 条规则  ${SRC} -> ${DEST}`);
