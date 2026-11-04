/**
 * verify-names.mjs — 完整名称确定性 + 描述召回 + 单字入口
 *
 * 对应评测报告的三条 P1：
 *   - 110 个完整名称逐一查询，必须每个都排第一（报告实测仅 70/110）
 *   - 词表外新技能靠描述也能被搜到（报告实测返回空）
 *   - 单字人工入口（如「爬」）可用
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rankCandidates, normalize } from './rank-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));

const idx = readJson(join(HERE, 'index.json'));

// 与 verify-client 同理：断言绑定开发者技能库里的具体技能名。
const REF_MARK = ['gsap-core', 'tdd', 'code-review'];
if (!REF_MARK.some((n) => idx.skills.some((s) => s.name === n))) {
  console.log('\nSKIP: 当前 index.json 不含基准数据集，名称覆盖断言不适用');
  process.exit(0);
}

const aliases = readJson(join(HERE, 'aliases.json'));
const curated = readJson(join(HERE, 'curated.json'));
const skills = idx.skills.filter((s) => s.userInvocable);

let pass = 0;
let fail = 0;
const fails = [];

function ok(cond, label, detail) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + label);
  } else {
    fail++;
    console.log('  ✗ ' + label + (detail ? '  → ' + detail : ''));
    fails.push(label);
  }
}

/* ---------------- 1. 完整名称：必须排第一 ---------------- */

console.log('[1] 110 个完整名称逐一查询');
const notFirst = [];
for (const s of skills) {
  const r = rankCandidates(skills, s.name, aliases, { curated }) || [];
  if (!r.length || r[0].name !== s.name) {
    notFirst.push({ q: s.name, got: r.length ? r[0].name : '（空）', rank: r.findIndex((x) => x.name === s.name) });
  }
}
ok(notFirst.length === 0, `全部 ${skills.length} 个名称都排第一`, notFirst.slice(0, 8).map((x) => `${x.q}→${x.got}(#${x.rank})`).join('; '));

// 大小写/空格/下划线等写法变化也必须稳定
const variants = ['Code-Review', 'code_review', 'CODE REVIEW', ' code-review '];
let variantOk = 0;
for (const v of variants) {
  const r = rankCandidates(skills, v, aliases, { curated }) || [];
  if (r.length && r[0].name === 'code-review') variantOk++;
}
ok(variantOk === variants.length, `名称写法的变体同样命中（${variantOk}/${variants.length}）`);

/* ---------------- 2. 描述召回：词表外技能 ---------------- */

console.log('\n[2] 词表外的新技能靠描述可被搜到');
const phantom = [
  ...skills,
  { name: 'new-skill-xyz', description: '用于校准温度传感器', modelInvocable: true },
];
const descHit = rankCandidates(phantom, '校准温度', aliases, { curated }) || [];
ok(descHit.length > 0 && descHit[0].name === 'new-skill-xyz', '描述命中新技能', descHit.slice(0, 3).map((x) => x.name).join(','));

/* ---------------- 3. 单字人工入口 ---------------- */

console.log('\n[3] 单字人工入口');
const one = rankCandidates(skills, '爬', aliases, { curated }) || [];
ok(one.length > 0 && one[0].name === 'agent-browser', '「爬」命中 agent-browser', one.slice(0, 3).map((x) => x.name).join(','));
const two = rankCandidates(skills, '爬取', aliases, { curated }) || [];
ok(two.length > 0 && two[0].name === 'agent-browser', '「爬取」仍命中 agent-browser', two.slice(0, 3).map((x) => x.name).join(','));

// 单字不该泛滥：随便一个常见字不应返回一堆
const noise = rankCandidates(skills, '的', aliases, { curated }) || [];
ok(noise.length === 0, '无意义的单字不产生结果', String(noise.length));

/* ---------------- 4. 中文回归：不能被改坏 ---------------- */

console.log('\n[4] 中文意图回归（抽查 8 条）');
const spot = [
  ['做一份演示文稿', ['slides', 'ppt-master', 'deck-guizang-editorial', 'deck-open-slide-canvas', 'deck-swiss-international']],
  ['把pdf转成word', ['office-export-pdf', 'office-docx']],
  ['给页面加滚动动画', ['gsap-scrolltrigger', 'gsap-core', 'gsap-timeline']],
  ['做个落地页', ['landing-page-design-hard-rules']],
  ['这个 bug 查一下', ['diagnosing-bugs']],
  ['审查我的分支', ['code-review']],
  ['字体怎么选', ['web-typography']],
  ['论文汇总做成网页', ['paper-digest-html']],
];
for (const [q, targets] of spot) {
  const r = rankCandidates(skills, q, aliases, { curated }) || [];
  const hit = r.slice(0, 3).some((x) => targets.includes(x.name));
  ok(hit, `「${q}」`, r.slice(0, 2).map((x) => x.name).join(','));
}

console.log(`\n断言：${pass} 通过 / ${fail} 失败`);
if (fail) process.exitCode = 1;
