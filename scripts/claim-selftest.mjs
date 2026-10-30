#!/usr/bin/env node
// claim-structure 自检（OpenSpec xingyan-claim-layer 任务 1.5 验证）。
//
// 为什么值得有：发布闸逻辑一旦写反（该拦的放过、该过的拦死），生产上表现为
// 「发不出去」或「该拦的没拦」，两者都很难从 admin 的报错文本反推。这里把四类
// 判定固化成可重跑的用例。
//
// 用法：npm run claims:selftest
// 依赖：node 的类型擦除（tsx 或 node --experimental-strip-types）；本仓用 tsx 执行。

import { checkClaims, checkClaimsAcrossLocales } from '../src/rules/claim-structure.ts';

const SRC = [{ id: 'src-1', label: '评测报告' }];
let failed = 0;

function expectBlock(name, actual, shouldBlock) {
  const blocked = actual.length > 0;
  const ok = blocked === shouldBlock;
  if (!ok) failed++;
  console.log(
    `${ok ? '✓' : '✗'} ${name}（期望${shouldBlock ? '拦截' : '放行'}，实得${blocked ? '拦截' : '放行'}` +
      `${actual.length ? `：${actual.map((i) => i.rule).join(',')}` : ''}）`,
  );
}

expectBlock('四要素齐备且证据可解析', checkClaims([{ id: 'c0001', section: '结果', type: 'number', evidence: ['src-1'] }], SRC), false);
expectBlock('缺 evidence', checkClaims([{ id: 'c0001', section: '结果', type: 'number' }], SRC), true);
expectBlock('缺 section', checkClaims([{ id: 'c0001', type: 'number', evidence: ['src-1'] }], SRC), true);
expectBlock('type 不在枚举', checkClaims([{ id: 'c0001', section: '结果', type: 'opinion', evidence: ['src-1'] }], SRC), true);
expectBlock('evidence 悬空', checkClaims([{ id: 'c0001', section: '结果', type: 'number', evidence: ['src-9'] }], SRC), true);
expectBlock('claim id 格式错', checkClaims([{ id: 'C1', section: '结果', type: 'number', evidence: ['src-1'] }], SRC), true);
expectBlock('claim id 重复', checkClaims([
  { id: 'c0001', section: '结果', type: 'number', evidence: ['src-1'] },
  { id: 'c0001', section: '结论', type: 'causal', evidence: ['src-1'] },
], SRC), true);
expectBlock('来源 id 格式错', checkClaims([], [{ id: 'SRC1', label: 'x' }]), true);
expectBlock('未声明 claims（存量兼容）', checkClaims([], ['纯文本来源']), false);

expectBlock('双语 ID 集合不同构', checkClaimsAcrossLocales([
  { locale: 'zh', claims: [{ id: 'c0001', type: 'number' }, { id: 'c0002', type: 'causal' }] },
  { locale: 'en', claims: [{ id: 'c0001', type: 'number' }] },
]), true);
expectBlock('双语类型不一致', checkClaimsAcrossLocales([
  { locale: 'zh', claims: [{ id: 'c0001', type: 'number' }] },
  { locale: 'en', claims: [{ id: 'c0001', type: 'causal' }] },
]), true);
expectBlock('双语同构', checkClaimsAcrossLocales([
  { locale: 'zh', claims: [{ id: 'c0001', type: 'number' }] },
  { locale: 'en', claims: [{ id: 'c0001', type: 'number' }] },
]), false);
expectBlock('单语条目不判双语', checkClaimsAcrossLocales([{ locale: 'zh', claims: [{ id: 'c0001', type: 'number' }] }]), false);

if (failed) {
  console.error(`\n✗ ${failed} 条用例失败——claim 发布闸逻辑与契约不符。`);
  process.exit(1);
}
console.log('\n✓ claim 发布闸自检全过。');
