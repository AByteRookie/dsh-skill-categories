#!/usr/bin/env node
/**
 * promote.mjs — 把「分不出来」的技能升格成新分类
 *
 * 这是插件自我迭代的固化环节：
 *   运行时（client.js）能当场给新技能分类，分不出的按名字族临时成组，
 *   但那是每次启动重算的。要让「新种类」沉淀下来，就得写进 taxonomy.local.json，
 *   再由 build.mjs 参与正式分类、pack.mjs 带进运行时规则。
 *
 * 用法：
 *   node promote.mjs            # 只报告，不写文件
 *   node promote.mjs --apply    # 写入 taxonomy.local.json
 *   node promote.mjs --min 3    # 成族的阈值（默认 3）
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from './paths.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

const MIN = Number(val('--min') || 3);
const APPLY = has('--apply');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const safe = (p, d) => {
  try {
    return readJson(p);
  } catch {
    return d;
  }
};

const idx = readJson(join(ROOT, 'index.json'));
let local = safe(join(ROOT, 'taxonomy.local.json'), { categories: [] });
local.categories = local.categories || [];

const visible = idx.skills.filter((s) => s.userInvocable);
const misc = visible.filter((s) => s.category === 'misc');

console.log(`\n可见技能 ${visible.length}，其中未归类 ${misc.length}`);

if (!misc.length) {
  console.log('没有需要升格的技能。');
  console.log('（装了新技能后先跑 node setup.mjs，让它们进索引，再来跑这个）');
  process.exit(0);
}

/* ---------------------------- 按名字族聚类 ---------------------------- */

const fam = {};
for (const s of misc) {
  const key = String(s.name).split('-')[0] || 'other';
  (fam[key] = fam[key] || []).push(s);
}

const proposals = [];
for (const [key, items] of Object.entries(fam)) {
  if (items.length < MIN) continue;
  proposals.push({
    id: `x-${key.toLowerCase().replace(/[^a-z0-9]+/g, '')}`,
    label: key,
    glyph: '✦',
    order: 900 + proposals.length * 10,
    blurb: `${key} 相关（自动聚合）`,
    keywords: [key],
    skills: items.map((s) => s.name),
    count: items.length,
  });
}

const leftovers = misc.filter((s) => !proposals.some((p) => p.skills.includes(s.name)));

console.log(`\n可升格的名字族（≥${MIN} 个）：${proposals.length}`);
for (const p of proposals) {
  console.log(`  ${p.label}  ${p.count} 个   → id=${p.id}`);
  console.log(`     ${p.skills.slice(0, 6).join(', ')}${p.skills.length > 6 ? ' …' : ''}`);
}

if (leftovers.length) {
  console.log(`\n落单（保持未归类）：${leftovers.length}`);
  for (const s of leftovers.slice(0, 10)) console.log(`  ${s.name}`);
}

if (!proposals.length) {
  console.log('\n没有达到阈值的名字族，暂不新建分类。');
  process.exit(0);
}

/* ---------------------------- 写入 ---------------------------- */

if (!APPLY) {
  console.log('\n这是干跑。确认后加 --apply 写入 taxonomy.local.json，');
  console.log('再跑 node setup.mjs 就会把它变成一个真正的分类。');
  process.exit(0);
}

for (const p of proposals) {
  const existing = local.categories.find((c) => c.id === p.id);
  if (existing) {
    existing.skills = [...new Set([...(existing.skills || []), ...p.skills])];
    existing.keywords = [...new Set([...(existing.keywords || []), ...p.keywords])];
  } else {
    local.categories.push(p);
  }
}

writeFileSync(
  join(ROOT, 'taxonomy.local.json'),
  JSON.stringify(
    {
      note: '由 promote.mjs 生成；每个 category 是一条本地扩展分类，build.mjs 会把它并入分组，pack.mjs 会把它带进运行时规则。',
      updatedAt: new Date().toISOString(),
      categories: local.categories,
    },
    null,
    2
  ),
  'utf8'
);

console.log(`\n已写入 ${join(ROOT, 'taxonomy.local.json')}（${local.categories.length} 条本地分类）`);
console.log('接着跑 node setup.mjs 生效。');
