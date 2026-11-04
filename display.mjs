/**
 * display.mjs — 9 个展示类（菜单里的分组骨架）
 *
 * 设计取舍：
 *   现有 taxonomy.mjs 里的 13 个类是「细分面（facet）」，规则打磨过、置信度高。
 *   直接把规则重写成 9 类风险大且没必要 —— 菜单只需要 9 个**展示骨架**。
 *   所以这里做一层 facet → display 的映射：
 *     - 分类判定仍由 13 个 facet 负责（精度）
 *     - 菜单分组只暴露 9 类（可扫读）
 *     - facet 保留在索引里，作为二级标签备用，不进菜单
 *
 * 依据：Kiger 的「宽而浅」方向（原文未核实，仅方向性）+ 本机 110 个技能的实际分布。
 */

export const DISPLAY = [
  {
    id: 'design',
    label: '设计与视觉',
    glyph: '◐',
    order: 10,
    blurb: '定风格、改界面、评审视觉',
    facets: ['style', 'ui'],
  },
  {
    id: 'page',
    label: '页面与转化',
    glyph: '▭',
    order: 20,
    blurb: '落地页、改版、复刻、FAQ',
    facets: ['page'],
  },
  {
    id: 'visual',
    label: '图像与素材',
    glyph: '◨',
    order: 30,
    blurb: '生图、电商图、样机、精灵图',
    facets: ['image'],
  },
  {
    id: 'deck',
    label: '演示与图示',
    glyph: '▦',
    order: 40,
    blurb: '幻灯片、PPTX、架构图',
    facets: ['deck'],
  },
  {
    id: 'motion',
    label: '动效与动画',
    glyph: '◔',
    order: 50,
    blurb: 'GSAP、滚动叙事、动效评审',
    facets: ['motion'],
  },
  {
    id: 'career',
    label: '求职与职业',
    glyph: '◈',
    order: 55,
    blurb: '简历、面试、offer 谈判、职业转型',
    facets: ['career'],
  },
  {
    id: 'content',
    label: '内容与运营',
    glyph: '◍',
    order: 60,
    blurb: '写稿、选题、公众号、调研纪要',
    facets: ['wechat', 'research'],
  },
  {
    id: 'doc',
    label: '文档与办公',
    glyph: '▣',
    order: 70,
    blurb: 'Word / Excel / PPT / PDF',
    facets: ['office'],
  },
  {
    id: 'eng',
    label: '工程与质量',
    glyph: '⌘',
    order: 80,
    blurb: 'TDD、诊断、建模、拆票推进',
    facets: ['eng', 'flow'],
  },
  {
    id: 'review-tool',
    label: '评审与工具',
    glyph: '⚖',
    order: 90,
    blurb: '可用性评审、浏览器、CLI、技能管理',
    facets: ['review', 'tools'],
  },
];

/** facet id → display id */
export const FACET_TO_DISPLAY = new Map();
for (const d of DISPLAY) for (const f of d.facets) FACET_TO_DISPLAY.set(f, d.id);

export const DISPLAY_BY_ID = new Map(DISPLAY.map((d) => [d.id, d]));

/** misc 的展示位（放在最后，且不参与「新类」计算） */
export const MISC_DISPLAY = { id: 'misc', label: '未归类', glyph: '·', order: 999 };

/** 把 facet 判定结果折算成展示类 */
export function toDisplay(facetId) {
  return FACET_TO_DISPLAY.get(facetId) || 'misc';
}
