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

/* ---------------------------- 生态族：构建期整体成组 ---------------------------- */

/**
 * 一整套引擎/平台技能（unity-* / godot-* / roblox-* …）常常共享前缀。
 * 逐条规则分类会被 script / build / animation 这类通用词打散到好几个类里，
 * 用户看到的是一堆碎片而不是一个生态。
 *
 * 为什么必须放在构建期：
 *   每个用户自己的技能都会在 setup 时烘焙进 index.json，
 *   而运行时的族聚合只对「装进来以后才发现的新技能」生效。
 *   不做这一步，陌生人装完插件，他的 unity-* 就是散的。
 *
 * 判定条件：该前缀成员 ≥ 阈值，且它们本来落在 ≥2 个不同类里（说明规则没有共识）。
 */
const FAMILY_MIN_LARGE = 5;
const FAMILY_MIN_SMALL = 3;
const famMin = classified.filter((s) => s.userInvocable).length < 60 ? FAMILY_MIN_SMALL : FAMILY_MIN_LARGE;

const famBuckets = new Map();
for (const s of classified) {
  if (!s.userInvocable) continue;
  if (s.tier === 'manual') continue; // 人工指定优先，不参与自动成族
  const pre = String(s.name).split('-')[0];
  if (pre.length < 3) continue;
  if (!famBuckets.has(pre)) famBuckets.set(pre, []);
  famBuckets.get(pre).push(s);
}

const dynGroups = [];
const KNOWN_NAMES = new Set(classified.map((s) => s.name));
for (const [pre, list] of famBuckets) {
  if (list.length < famMin) continue;
  // 前缀本身是个独立技能名（design / deck / web …）→ 这是共用词，不是生态
  if (KNOWN_NAMES.has(pre)) continue;

  const cats = new Set(list.map((s) => s.category));
  if (cats.size < 2) continue; // 本来就落在一起，不需要干预

  // 只有当规则对这批技能普遍没把握时才整体成族：
  // 低置信度（low）或分数不足的成员占多数，说明规则没有共识。
  const weak = list.filter((s) => s.tier === 'low' || (s.score || 0) < 6);
  if (weak.length < Math.ceil(list.length * 0.6)) continue;

  const id = 'dyn-' + pre.toLowerCase().replace(/[^a-z0-9]+/g, '');
  for (const s of list) {
    s.facet = id;
    s.category = id;
    s.tier = 'family';
    s.reason = `同族聚合（${list.length} 个 ${pre}-*，规则低置信且分散在 ${cats.size} 个类）`;
  }
  dynGroups.push({ id, label: '✦ ' + pre, glyph: '✦', order: 900 + dynGroups.length * 10, blurb: `${pre}-* 生态`, facets: [id] });
}
if (dynGroups.length) {
  console.log(`同族聚合：${dynGroups.map((g) => g.label).join('、')}`);
}

/* ---------------------------- 统计 ---------------------------- */

const visible = classified.filter((s) => s.userInvocable);

const byDisplay = new Map();
for (const s of visible) {
  if (!byDisplay.has(s.category)) byDisplay.set(s.category, []);
  byDisplay.get(s.category).push(s);
}

const orderOf = (id) => {
  if (displayMeta.has(id)) return displayMeta.get(id).order;
  const dyn = dynGroups.find((g) => g.id === id);
  if (dyn) return dyn.order;
  return MISC_DISPLAY.order;
};
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
  taxonomy: [
    ...ALL_DISPLAY.map(({ id, label, glyph, order, blurb, facets }) => ({ id, label, glyph, order, blurb, facets })),
    ...dynGroups,
  ],
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
