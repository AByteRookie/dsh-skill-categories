/**
 * verify-consistency.mjs — 「分类依据」的一致性闸门
 *
 * 背景：出现过两次「菜单数字和文档/测试报的不一样」：
 *   ① 烘焙进 bundle 的计数只算 userInvocable，而列表把隐藏技能也渲染出来
 *      → 芯片写「评审 19」，底下却列了 21 行；
 *   ② 运行期对索引外的新技能用简化规则现算，构建期用完整裁决
 *      → 同一个技能「装完看到的类」和「下次重建后的类」不一致。
 *
 * 这份用例把两条都钉死：索引是唯一真源，运行期算法必须能逐条复现索引的结论。
 *
 * 断言（任何一条红就说明用户看到的东西会和测试不符）：
 *   1. bundle 的 MAP 键集合 == index.json 的技能名集合
 *   2. MAP[name] === index.category（逐条）
 *   3. CATCOUNT 各项 == 按 category 统计的条目数（含 misc）
 *   4. TOTAL == index.skills.length == Σ CATCOUNT
 *   5. 用 bundle 里的 RULES/RSCORE/F2D 现场重算每条技能，结果 === index.category
 *   6. index 出现的每个 facet 都有 RULES 表项、都有 F2D 映射
 *   7. RSCORE 三个参数与 taxonomy.mjs 的导出常量一致
 *
 * 用法：node verify-consistency.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginDir } from './paths.mjs';
import { MIN_SCORE, NAME_BOOST, STRONG_NAME_BONUS } from './taxonomy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(pluginDir(), 'lib', 'client.js');
const INDEX = join(HERE, 'index.json');

let pass = 0;
const fails = [];
function ok(cond, title, detail = '') {
  if (cond) {
    pass++;
    return true;
  }
  fails.push(`${title}${detail ? ` — ${detail}` : ''}`);
  return false;
}

/* ------------------------- 读取产物 ------------------------- */

const bundle = readFileSync(CLIENT, 'utf8');

/** 从 bundle 里截出 `var NAME = {...}` / `[...]` / 数字 字面量 */
function grab(name) {
  const key = `var ${name} = `;
  const at = bundle.indexOf(key);
  if (at < 0) throw new Error(`bundle 里找不到 ${name}`);
  let i = at + key.length;
  if (!/[[{]/.test(bundle[i])) {
    // 数字 / 布尔
    const end = bundle.indexOf(';', i);
    return JSON.parse(bundle.slice(i, end));
  }
  const open = bundle[i];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  const start = i;
  for (; i < bundle.length; i++) {
    const ch = bundle[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (!depth) {
        i++;
        break;
      }
    }
  }
  return JSON.parse(bundle.slice(start, i));
}

const MAP = grab('MAP');
const CATCOUNT = grab('CATCOUNT');
const CATS = grab('CATS');
const TOTAL = grab('TOTAL');
const RULES = grab('RULES');
const RSCORE = grab('RSCORE');
const F2D = grab('F2D');
const idx = JSON.parse(readFileSync(INDEX, 'utf8'));

const idxNames = idx.skills.map((s) => s.name).sort();
const mapNames = Object.keys(MAP).sort();

console.log(`产物 ${CLIENT}`);
console.log(`索引 ${idx.skills.length} 条 · MAP ${mapNames.length} 条 · TOTAL ${TOTAL}\n`);

/* ------------------------- 1. 键集合 ------------------------- */

{
  const onlyIdx = idxNames.filter((n) => !(n in MAP));
  const onlyMap = mapNames.filter((n) => !idxNames.includes(n));
  ok(
    !onlyIdx.length && !onlyMap.length,
    'MAP 与索引用同集合',
    [
      onlyIdx.length ? `索引有 ${onlyIdx.length} 条 MAP 缺：${onlyIdx.slice(0, 3).join(', ')}` : '',
      onlyMap.length ? `MAP 多出 ${onlyMap.length} 条：${onlyMap.slice(0, 3).join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('；'),
  );
}

/* ------------------------- 2. 逐条分类一致 ------------------------- */

{
  const diff = idx.skills.filter((s) => MAP[s.name] && MAP[s.name] !== s.category);
  ok(
    !diff.length,
    'MAP[name] === index.category',
    diff
      .slice(0, 5)
      .map((s) => `${s.name}(${MAP[s.name]}≠${s.category})`)
      .join(' '),
  );
}

/* ------------------------- 3/4. 计数口径 ------------------------- */

{
  const want = {};
  for (const s of idx.skills) want[s.category] = (want[s.category] || 0) + 1;

  const catKeys = new Set([...Object.keys(want), ...Object.keys(CATCOUNT)]);
  const bad = [];
  for (const k of catKeys) {
    const a = want[k] || 0;
    const b = CATCOUNT[k] || 0;
    if (a !== b) bad.push(`${k}: 索引 ${a} / bundle ${b}`);
  }
  ok(!bad.length, 'CATCOUNT 与索引逐类相等', bad.join('；'));

  const sum = Object.values(CATCOUNT).reduce((a, b) => a + b, 0);
  ok(
    TOTAL === idx.skills.length && sum === idx.skills.length,
    'TOTAL == 索引条数 == ΣCATCOUNT',
    `TOTAL=${TOTAL} 索引=${idx.skills.length} Σ=${sum}`,
  );
}

/* ------------------------- 5. 运行期算法复现索引 ------------------------- */

{
  const cache = new Map();
  const parseRe = (src) => {
    if (!cache.has(src)) {
      try {
        const last = src.lastIndexOf('/');
        cache.set(src, new RegExp(src.slice(1, last), src.slice(last + 1)));
      } catch {
        cache.set(src, null);
      }
    }
    return cache.get(src);
  };

  /** 与 bundle 内 classifyRuntime 逐字对应的复刻（不共享代码，故意的：验证的是产物行为） */
  function runtimeFacet(name, desc) {
    const hayName = String(name).replace(/-/g, ' ');
    const text = String(desc || '');
    let bestId = null;
    let bestScore = 0;
    for (const cat of RULES) {
      let score = 0;
      for (const sr of cat.strong) {
        const r = parseRe(sr);
        if (r && r.test(name)) score += RSCORE.strong;
      }
      for (const [pat, w] of cat.rules) {
        const r = parseRe(pat);
        if (!r) continue;
        if (r.test(text)) score += w;
        if (r.test(hayName)) score += w * RSCORE.boost;
      }
      if (score > bestScore) {
        bestScore = score;
        bestId = cat.id;
      }
    }
    return bestScore >= RSCORE.min ? bestId : null;
  }

  const drift = [];
  let checked = 0;
  let skipped = 0;
  for (const s of idx.skills) {
    // 人工覆盖与同族聚合是构建期裁决，运行期规则复现不出来（也不该复现）
    if (s.tier === 'manual' || s.tier === 'family' || String(s.category).startsWith('dyn-')) {
      skipped++;
      continue;
    }
    checked++;
    const facet = runtimeFacet(s.name, s.desc || '');
    const display = facet ? F2D[facet] || facet : 'misc';
    if (display !== s.category) drift.push(`${s.name}: 现算 ${display} ≠ 索引 ${s.category}`);
  }
  ok(!drift.length, `运行期算法复现索引分类（${checked} 条）`, drift.slice(0, 5).join('；'));
  if (skipped) console.log(`  · 跳过 ${skipped} 条构建期裁决（人工/同族），不计入复现断言`);
}

/* ------------------------- 6. 规则表与映射完备 ------------------------- */

{
  const ruleIds = new Set(RULES.map((r) => r.id));
  // misc 是「没有规则命中」的兜底，不是规则类，本来就不该出现在 RULES 里
  const facets = new Set(idx.skills.map((s) => s.facet).filter((f) => f && f !== 'misc'));
  const noRule = [...facets].filter((f) => !ruleIds.has(f) && !String(f).startsWith('dyn-'));
  ok(!noRule.length, '每个 facet 都有运行期规则', noRule.slice(0, 5).join(', '));

  const noMap = [...facets].filter((f) => !F2D[f] && !Object.prototype.hasOwnProperty.call(CATS, f));
  ok(!noMap.length, '每个 facet 都能映射到展示类', noMap.slice(0, 5).join(', '));

  const unreachable = Object.keys(CATCOUNT).filter((c) => CATCOUNT[c] > 0 && !CATS[c]);
  ok(!unreachable.length, 'CATCOUNT 里的类都能在 CATS 找到', unreachable.join(', '));
}

/* ------------------------- 7. 参数一致 ------------------------- */

{
  ok(
    RSCORE.min === MIN_SCORE && RSCORE.boost === NAME_BOOST && RSCORE.strong === STRONG_NAME_BONUS,
    'RSCORE 与 taxonomy.mjs 参数一致',
    `bundle=${JSON.stringify(RSCORE)} 源码={min:${MIN_SCORE},boost:${NAME_BOOST},strong:${STRONG_NAME_BONUS}}`,
  );
}

/* ------------------------- 汇总 ------------------------- */

console.log(`\n断言：${pass} 通过 / ${fails.length} 失败`);
if (fails.length) {
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('分类依据一致：菜单 = 索引 = 运行期算法');
