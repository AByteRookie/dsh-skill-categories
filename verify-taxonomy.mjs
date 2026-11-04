#!/usr/bin/env node
/**
 * verify-taxonomy.mjs — 分类器的独立测试（不依赖任何人的技能库）
 *
 * 为什么单独做成一份：verify-client / verify-names / verify-query 都要读 index.json，
 * 而 index 是本地生成的。CI 上没有 DSH，跑不了那三个。这份用内联样本，
 * 任何机器 clone 下来就能验，用来守住分类规则不退化。
 *
 * 它也守住一个具体的坑：EN_RULES 的 key 必须等于 TAXONOMY 的 facet id。
 * 曾经写成展示类 id（doc / visual / review-tool），那几组规则静默失效了两轮。
 */

import { TAXONOMY, EN_RULES, scoreSkill } from './taxonomy.mjs';
import { DISPLAY, toDisplay, DISPLAY_BY_ID } from './display.mjs';

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, title, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${title}`);
  } else {
    fail++;
    failures.push(title + (detail ? `  → ${detail}` : ''));
    console.log(`  ✗ ${title}${detail ? '  → ' + detail : ''}`);
  }
}

const cls = (name, desc) => toDisplay(scoreSkill({ name, desc }).category);

/* ---------------------------- 1. 规则表结构 ---------------------------- */

console.log('\n[1] 规则表结构');

const facetIds = new Set(TAXONOMY.map((c) => c.id));
const badKeys = Object.keys(EN_RULES).filter((k) => !facetIds.has(k));
ok(badKeys.length === 0, 'EN_RULES 的 key 全部是真实 facet id', badKeys.join(','));

// DISPLAY_BY_ID 是 Map，不能用 Object.keys 取 id
const displayIds = new Set(DISPLAY.map((d) => d.id));
const orphan = [...displayIds].filter((d) => d !== 'misc' && !TAXONOMY.some((c) => toDisplay(c.id) === d));
ok(orphan.length === 0, '每个展示类都至少映射到一个 facet', orphan.join(','));

ok(TAXONOMY.every((c) => Array.isArray(c.rules) && c.rules.length > 0), '每个 facet 都有规则');
ok(new Set(TAXONOMY.map((c) => c.id)).size === TAXONOMY.length, 'facet id 不重复');

// 展示类必须自洽：id 唯一、facets 都存在、order 递增
ok(DISPLAY.length === displayIds.size, `展示类 ${DISPLAY.length} 个且 id 唯一`);
ok(
  DISPLAY.every((d) => d.facets.every((f) => facetIds.has(f))),
  '每个展示类的 facets 都指向真实 facet',
  DISPLAY.flatMap((d) => d.facets).filter((f) => !facetIds.has(f)).join(',')
);
ok(
  DISPLAY.every((d, i) => i === 0 || DISPLAY[i - 1].order < d.order),
  '展示类 order 严格递增'
);
ok(displayIds.has('career'), 'career 已注册为展示类（不是运行时补丁）');

/* ---------------------------- 2. 中文样本 ---------------------------- */

console.log('\n[2] 中文描述');

const zh = [
  ['hallmark', '反 AI 套路设计：新建页面、审计、改版，从 URL 或截图提取设计', 'design'],
  [
    'web-ui-design',
    'Web UI 设计规范与优化｜苹果风 HIG｜清爽简约｜设计令牌与组件｜动效与滚动编排（GSAP）｜可访问性与对比度｜设计走查清单。调整配色/字体/间距/圆角/阴影、加交互与动效、做滚动叙事',
    'design',
  ],
  ['gsap-scrolltrigger', '滚动驱动动画、钉住、视差、ScrollTrigger 触发器', 'motion'],
  ['office-pptx', '创建、读取、编辑 PowerPoint 演示文稿', 'doc'],
  ['aws-wechat-article-writing', '公众号长文写作，改写、续写、润色', 'content'],
  ['deck-guizang-editorial', '编辑杂志感幻灯片，10 种版式与 5 套配色', 'deck'],
  ['landing-page-design-hard-rules', '从零做一个高转化的落地页：页面结构、转化文案、SEO', 'page'],
  ['audio-to-structured-notes', '把长录音（访谈、路演、会议）转成带时间戳、可回听核对的结构化中文笔记', 'content'],
];

for (const [name, desc, want] of zh) {
  const got = cls(name, desc);
  ok(got === want, `${name} → ${want}`, got);
}

/* ---------------------------- 3. 英文样本（外部仓库学到的） ---------------------------- */

console.log('\n[3] 英文描述（覆盖跨语料泛化）');

const en = [
  ['mcp-builder', 'Guide for creating high-quality MCP servers that let LLMs call external APIs', 'review-tool'],
  ['obsidian-markdown', 'Create and edit Obsidian Flavored Markdown with wikilinks and callouts', 'doc'],
  ['json-canvas', 'Create and edit JSON Canvas files (.canvas) with nodes and edges', 'doc'],
  ['pdf', 'Comprehensive PDF manipulation toolkit for extracting text and tables', 'doc'],
  ['algorithmic-art', 'Creating algorithmic art using p5.js with seeded randomness', 'visual'],
  ['brand-guidelines', "Applies Anthropic's official brand colors and typography to artifacts", 'design'],
  ['theme-factory', 'Toolkit for styling artifacts with a theme; preset themes for slides and docs', 'design'],
  ['deploying-to-production', 'Automate creating a GitHub repository and deploying a web project to Vercel', 'eng'],
  ['writing-plans', 'Use when you have a spec for a multi-step task, before touching code', 'eng'],
  ['skill-creator', 'Guide for creating effective skills that extend capabilities', 'review-tool'],
  ['google-official-seo-guide', 'Official Google SEO guide covering search optimization and indexing', 'page'],
  ['x-article-publisher', 'Publish Markdown articles to X (Twitter) Articles editor', 'content'],
  ['internal-comms', 'Write internal communications: status reports, company newsletters, announcements', 'content'],
  ['pptx', 'Create, read, edit, and validate PowerPoint presentations (.pptx)', 'deck'],
];

for (const [name, desc, want] of en) {
  const got = cls(name, desc);
  ok(got === want, `${name} → ${want}`, got);
}

/* ---------------------------- 4. 家族一致性 ---------------------------- */

console.log('\n[4] 家族必须整族同类');

ok(cls('office', 'Create, edit, inspect, or convert Office documents') === 'doc', 'office 总入口在文档类');
ok(cls('office-docx', 'Create, read, edit Word documents (.docx)') === 'doc', 'office-docx 在文档类');
ok(cls('office-xlsx', 'Read, create, edit Excel workbooks (.xlsx)') === 'doc', 'office-xlsx 在文档类');
ok(cls('office-pptx', 'Create, read, edit PowerPoint presentations (.pptx)') === 'doc', 'office-pptx 留在文档类（不被 pptx 拽走）');

/* ---------------------------- 5. 空输入 ---------------------------- */

console.log('\n[4b] 求职与职业（第 10 个展示类）');

const career = [
  ['resume-writer', '从工作经历写出完整简历', 'career'],
  ['interview-prep', '准备某个岗位的面试，行为面试题库', 'career'],
  ['offer-negotiation', '评估并谈判 offer，base 股权 sign-on', 'career'],
  ['academic-cv', '学术简历，论文与基金', 'career'],
  ['linkedin-profile-writer', '写 LinkedIn 简介与经历', 'career'],
  ['software-engineer-resume', '软件工程师简历', 'career'],
  ['get-jobs', 'Boss直聘 自动投递 岗位', 'career'],
  ['codex-cli-calling', '在命令行直接调用 Codex，不进交互界面', 'review-tool'],
  ['memory-consolidate', '整理、合并、去重累积的记忆', 'review-tool'],
  ['gpt-tasteskill', '顶级 UX/UI 与高级动效', 'design'],
  ['taste-skill-v1', 'v1 版本的设计品味 skill', 'design'],
];

for (const [name, desc, want] of career) {
  const got = cls(name, desc);
  ok(got === want, `${name} → ${want}`, got);
}

ok(cls('跑个无头浏览器截图', 'Playwright 驱动') === 'review-tool', '普通工具类不被 career 抢走');

console.log('\n[5] 边界');

ok(cls('totally-unknown-skill', '') === 'misc', '无信号 → 未归类');
ok(cls('x', 'zzz qqq') === 'misc', '无意义描述 → 未归类');
ok(typeof scoreSkill({ name: '', desc: '' }).category === 'string', '空技能也能返回字符串分类');

/* ---------------------------- 汇总 ---------------------------- */

console.log(`\n断言：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  · ' + f);
  process.exit(1);
}
