/**
 * verify-query.mjs — 验收：30 条中文意图的命中率
 *
 * 对比三组：
 *   A. 现状（只按技能名，复刻内置 rankByName）
 *   B. 方案 A（本地排序：别名 > 名称 > 描述）
 *
 * 判据（方案 A 承诺）：top1 ≥ 60%，top3 ≥ 80%。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rankCandidates } from './rank-core.mjs';
import { QUERIES } from './queries.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));

const idx = readJson(join(HERE, 'index.json'));
const aliases = readJson(join(HERE, 'aliases.json'));
const curated = readJson(join(HERE, 'curated.json'));
const skills = idx.skills.filter((s) => s.userInvocable);

/* 现状：复刻内置 rankByName（名称上的有序子序列 + 前缀优先） */
function baselineRank(list, query) {
  const q = String(query).toLowerCase().replace(/\s+/g, '');
  if (!q) return list.slice();
  const scored = [];
  for (const it of list) {
    const n = it.name.toLowerCase();
    if (n.startsWith(q)) { scored.push({ it, sc: 1000 - n.length }); continue; }
    let i = 0;
    for (let j = 0; j < n.length && i < q.length; j++) if (n[j] === q[i]) i++;
    if (i === q.length) scored.push({ it, sc: 200 - n.length });
  }
  scored.sort((a, b) => b.sc - a.sc);
  return scored.map((o) => o.it);
}

let baseTop1 = 0;
let baseTop3 = 0;
let newTop1 = 0;
let newTop3 = 0;
const rows = [];

for (const { q, targets } of QUERIES) {
  const base = baselineRank(skills, q);
  const neu = rankCandidates(skills, q, aliases, { curated }) || [];

  const b1 = base.length && targets.includes(base[0].name);
  const b3 = base.slice(0, 3).some((x) => targets.includes(x.name));
  const n1 = neu.length && targets.includes(neu[0].name);
  const n3 = neu.slice(0, 3).some((x) => targets.includes(x.name));

  if (b1) baseTop1++;
  if (b3) baseTop3++;
  if (n1) newTop1++;
  if (n3) newTop3++;

  rows.push({
    q,
    base: base.slice(0, 3).map((x) => x.name),
    neu: neu.slice(0, 3).map((x) => x.name),
    b3,
    n3,
  });
}

const n = QUERIES.length;
const pct = (x) => Math.round((x / n) * 100);

console.log(`\n共 ${n} 条中文意图查询\n`);
console.log('查询'.padEnd(22) + '现状 top3'.padEnd(34) + '方案A top3');
console.log('─'.repeat(110));
for (const r of rows) {
  const mark = r.n3 ? '✓' : '✗';
  const markB = r.b3 ? '✓' : '✗';
  const left = `${markB} ${r.base[0] || '—'}`.slice(0, 32).padEnd(34);
  const right = `${mark} ${r.neu.slice(0, 2).join(', ') || '—'}`.slice(0, 70);
  console.log(r.q.padEnd(22) + left + right);
}

console.log('\n' + '─'.repeat(110));
console.log(`现状    top1 ${baseTop1}/${n} (${pct(baseTop1)}%)   top3 ${baseTop3}/${n} (${pct(baseTop3)}%)`);
console.log(`方案 A  top1 ${newTop1}/${n} (${pct(newTop1)}%)   top3 ${newTop3}/${n} (${pct(newTop3)}%)`);

const pass = pct(newTop1) >= 60 && pct(newTop3) >= 80;
console.log(`\n判据：top1 ≥60% 且 top3 ≥80% → ${pass ? '通过' : '未通过'}`);

const misses = rows.filter((r) => !r.n3);
if (misses.length) {
  console.log('\n未命中的查询（需补入口词或调权重）：');
  for (const m of misses) console.log(`  · ${m.q}  →  ${m.neu.join(', ') || '（空）'}`);
  process.exitCode = pass ? 0 : 2;
}
