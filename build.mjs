/**
 * build.mjs — 生成 index.json（菜单与检索的唯一数据源）
 *
 * 数据形状（schema 2）：
 *   taxonomy  9 个展示类（菜单分组骨架）
 *   facets    13 个细分面（分类判定精度来源，不进菜单）
 *   skills[]  每条含 category(9) / facet(13) / aliases / safety / shortDesc / example
 *
 * 设计约束：
 *   - 菜单行只能显示 name + description，所以短描述必须压到一行（≤48 字）
 *   - 内置技能在 asar 内只读，分类数据一律旁挂，不改 SKILL.md
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TAXONOMY, scoreSkill } from './taxonomy.mjs';
import { DISPLAY, DISPLAY_BY_ID, toDisplay, MISC_DISPLAY } from './display.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));

const inv = readJson(join(HERE, 'inventory.json'));
const aliases = readJson(join(HERE, 'aliases.json'));

let overrides = {};
try {
  overrides = readJson(join(HERE, 'overrides.json'));
} catch {
  overrides = {};
}

/**
 * 用户自定义分类（由 promote.mjs 生成）。
 *
 * 为什么单独一个文件：内置 10 类是产品自带的，用户的领域分类是私有的、会变。
 * 放一起会让仓库变成个人配置；分开放，升级时不会冲突。
 */
let local = { categories: [] };
try {
  local = readJson(join(HERE, 'taxonomy.local.json'));
} catch {
  local = { categories: [] };
}

const LOCAL_DISPLAY = (local.categories || [])
  .filter((c) => c && c.id && c.label)
  .map((c) => ({
    id: c.id,
    label: c.label,
    glyph: c.glyph || '✦',
    order: Number(c.order) || 900,
    blurb: c.blurb || '',
    facets: [c.id],
    keywords: c.keywords || [],
    skills: c.skills || [],
  }));

/** 合并后的展示类表（内置 + 本地），按 order 排序 */
const ALL_DISPLAY = [...DISPLAY, ...LOCAL_DISPLAY].sort((a, b) => a.order - b.order);
const displayMeta = new Map(ALL_DISPLAY.map((d) => [d.id, d]));

/** 本地分类的匹配：显式技能名单优先，其次关键词 */
function matchLocalCategory(skill) {
  const hay = `${skill.name} ${skill.desc || ''}`;
  for (const c of LOCAL_DISPLAY) {
    if (c.skills.includes(skill.name)) return c.id;
  }
  for (const c of LOCAL_DISPLAY) {
    if (!c.keywords.length) continue;
    if (c.keywords.some((k) => k && hay.toLowerCase().includes(String(k).toLowerCase()))) return c.id;
  }
  return null;
}

/* ---------------------------- 短描述 ---------------------------- */
// 取第一个句子，上限 48 字。这是工程取舍（渲染器只给一行），不是论文结论。

function toShortDesc(desc) {
  const t = String(desc || '').trim();
  if (!t) return '';
  const first = t.split(/[。；;！!？?\n]/)[0].trim();
  const base = first || t;
  return base.length <= 48 ? base : base.slice(0, 47) + '…';
}

/* ---------------------------- 安全等级 ---------------------------- */
// read / write / exec。启发式判定，用于「exec 不进默认推荐」。

const EXEC_HINT = /(运行|执行|启动|拉起|shell|bash|命令行|脚本|子进程|后台|浏览器自动化|爬|抓取|反编译|逆向|进程|终端)/i;
const WRITE_HINT = /(写入|保存|导出|生成文件|发布|上传|推送|群发|改写|修改|编辑|重算|删除|创建)/i;

function toSafety(skill) {
  const hay = `${skill.name} ${skill.desc || ''}`;
  if (EXEC_HINT.test(hay)) return 'exec';
  if (WRITE_HINT.test(hay)) return 'write';
  return 'read';
}

/* ---------------------------- 分类 ---------------------------- */

const classified = inv.skills.map((s) => {
  const r = scoreSkill(s);
  const ov = overrides[s.name];
  const localHit = matchLocalCategory(s);

  // facet 可能来自：人工覆盖 > 本地分类 > 规则判定
  const facet = (ov && ov.category) || localHit || r.category;

  // facet 既可能是细分面（走映射），也可能直接是展示类 id（本地分类就是）
  const display = displayMeta.has(facet) ? facet : facet === 'misc' ? 'misc' : toDisplay(facet);

  return {
    name: s.name,
    desc: s.desc || '',
    shortDesc: toShortDesc(s.desc),
    category: display,
    facet,
    aliases: aliases[s.name] || [],
    safety: toSafety(s),
    example: null,
    source: s.source,
    sourceLabel: s.sourceLabel,
    userInvocable: s.userInvocable,
    tier: ov ? 'manual' : localHit ? 'high' : r.tier,
    score: r.score,
    reason: ov
      ? `人工指定（原规则判定 ${r.category}）`
      : localHit
        ? `本地分类命中（${localHit}）`
        : r.reason,
    altFacets: r.altCategories || [],
  };
});

/* ---------------------------- 统计 ---------------------------- */

const visible = classified.filter((s) => s.userInvocable);

const byDisplay = new Map();
for (const s of visible) {
  if (!byDisplay.has(s.category)) byDisplay.set(s.category, []);
  byDisplay.get(s.category).push(s);
}

const orderOf = (id) => (displayMeta.get(id) || MISC_DISPLAY).order;
const groups = [...byDisplay.entries()]
  .sort((a, b) => orderOf(a[0]) - orderOf(b[0]))
  .map(([id, items]) => {
    const meta = displayMeta.get(id) || MISC_DISPLAY;
    return {
      id,
      label: meta.label,
      glyph: meta.glyph,
      order: meta.order,
      count: items.length,
      skills: items.map((s) => s.name),
    };
  });

const tierCount = { high: 0, medium: 0, low: 0, manual: 0 };
for (const s of visible) tierCount[s.tier] = (tierCount[s.tier] || 0) + 1;

const safetyCount = { read: 0, write: 0, exec: 0 };
for (const s of visible) safetyCount[s.safety]++;

const index = {
  schema: 2,
  generatedAt: new Date().toISOString(),
  note:
    '旁挂分类索引。category 是 9 个展示类（菜单分组），facet 是 13 个细分面（判定精度）。' +
    '不写入 SKILL.md，因此对 asar 内置技能同样适用，且升级不丢。',
  taxonomy: ALL_DISPLAY.map(({ id, label, glyph, order, blurb, facets }) => ({ id, label, glyph, order, blurb, facets })),
  facets: TAXONOMY.map(({ id, label, glyph, order, blurb }) => ({ id, label, glyph, order, blurb })),
  stats: {
    total: classified.length,
    userInvocable: visible.length,
    groups: groups.length,
    misc: byDisplay.get('misc')?.length || 0,
    tiers: tierCount,
    safety: safetyCount,
    withAliases: visible.filter((s) => s.aliases.length >= 3).length,
  },
  groups,
  skills: classified,
};

writeFileSync(join(HERE, 'index.json'), JSON.stringify(index, null, 2), 'utf8');

/* ---------------------------- 控制台 ---------------------------- */

console.log(`\n技能 ${classified.length}（可见 ${visible.length}）→ ${groups.length} 个展示类`);
console.log(
  `置信度：high ${tierCount.high} / medium ${tierCount.medium} / low ${tierCount.low} / manual ${tierCount.manual}`
);
console.log(`安全级：read ${safetyCount.read} / write ${safetyCount.write} / exec ${safetyCount.exec}`);
console.log(`有 ≥3 个入口词：${index.stats.withAliases}/${visible.length}\n`);

const max = Math.max(...groups.map((g) => g.count), 1);
for (const g of groups) {
  const bar = '█'.repeat(Math.round((g.count / max) * 24));
  console.log(`${g.glyph} ${g.label.padEnd(10)} ${String(g.count).padStart(3)}  ${bar}`);
}
console.log(`\n→ ${join(HERE, 'index.json')}`);
