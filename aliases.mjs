/**
 * aliases.mjs — 为 110 个技能生成入口词（entryTerms）
 *
 * 为什么必须有这张表（本机实测）：
 *   110 个技能名 100% 是纯 ASCII kebab-case；只用名称匹配时，
 *   6 条真实中文意图查询（「做一份演示文稿」等）命中数为 0。
 *   所以别名不是优化项，是中文用户唯一的检索路径。
 *
 * 生成策略（三层，越靠前越可信）：
 *   1. OVERRIDES：人工手写，针对高频/高价值技能
 *   2. FAMILY：按命名族批量给词（gsap-* / office* / aws-wechat-* …）
 *   3. DERIVED：从 name 拆 token + 从 description 抽 IDF 高的中文二元组
 *
 * 约束：每个技能 3–5 个词，每个词 2–16 字，去重。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'aliases.json');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));

// 读 inventory 而不是 index：index 是 build 的产物，
// 而 build 又依赖别名 —— 读 index 会形成循环，导致新增技能拿不到入口词。
const inv = readJson(join(HERE, 'inventory.json'));
const skills = inv.skills;

/* ------------------------------------------------------------------ *
 * 1. 人工入口词
 * ------------------------------------------------------------------ */

const OVERRIDES = {
  // —— 页面与站点 ——
  'landing-page-design-hard-rules': ['落地页', 'landing', '转化页', '首屏', '介绍页', '产品页'],
  'redesign-existing-projects': ['改版', '重设计', '改一下这个站', '视觉升级'],
  'web-clone': ['复刻网站', '仿站', '抄个站', '克隆页面', '复刻'],
  'faq-page': ['faq', '常见问题', '帮助中心'],
  'banner-design': ['横幅', 'banner', '海报', '广告图'],
  'prototype': ['原型', '草稿', '试一版'],

  // —— 设计与视觉 ——
  'frontend-design': ['前端设计', '界面设计', '视觉方向'],
  'high-end-visual-design': ['高级感', '高端视觉', '显得贵', '难看', '不好看'],
  'design-taste-frontend': ['审美', '品味', '不像模板'],
  'design-taste-frontend-v1': ['旧版审美', 'v1 审美'],
  'hallmark': ['反套路', '套路审查', 'hallmark'],
  'impeccable': ['打磨界面', '界面提升', '全面优化', '难看'],
  'minimalist-ui': ['极简', '简约风', '性冷淡'],
  'industrial-brutalist-ui': ['工业风', '粗糙感', '军工终端'],
  'top-design': ['获奖级', '沉浸式', 'awwwards'],
  'doc-kami-parchment': ['纸感', '羊皮纸', '暖纸色'],
  'stitch-design-taste': ['stitch', '语义设计系统'],
  'refactoring-ui': ['修界面', '视觉层级', '间距配色', '配色', '难看', '不好看'],
  'web-ui-design': ['网页设计', 'ui 规范', '苹果风'],
  'ui-styling': ['组件样式', 'shadcn', 'tailwind'],
  'ui-ux-pro-max': ['ui 智能', '配色方案', '字体搭配', '配色'],
  'design-system': ['设计系统', '设计令牌', 'token'],
  'design-brief': ['设计简报', '需求转设计'],
  'design-everyday-things': ['可用性原理', '可供性', '设计原则'],
  'ios-hig-design': ['ios 设计', '苹果规范', 'hig'],
  'web-typography': ['字体', '选字体', '排版'],
  'microinteractions': ['微交互', '按钮反馈', '过渡细节'],
  'emil-design-eng': ['交互手感', 'emil', '细腻动效'],
  'steve-jobs-design-review': ['乔布斯评审', '砍功能', '产品品味'],
  'ux-heuristics': ['可用性', '启发式评审', '认知走查', '界面评审', '界面'],
  'web-design-optimization': ['网页优化', 'a11y', '对比度检查', '对比度', '难看'],
  'design': ['设计总览', '品牌识别', 'logo 生成'],
  'reference-design-contract': ['参考站', '设计交接单'],
  'brand': ['品牌语气', '品牌一致性'],
  'brandkit': ['品牌套件图', '品牌规范板', '品牌手册'],

  // —— 图像与素材 ——
  'imagegen-frontend-web': ['生图', '网页设计图', '出参考图'],
  'imagegen-frontend-mobile': ['移动端生图', 'app 界面图'],
  'ecommerce-image-workflow': ['电商图', '主图', '卖点图'],
  'mockup-device-3d': ['样机', 'mockup', '手机壳展示'],
  'hatch-pet': ['精灵图', '宠物动画', '雪碧图'],
  'image-to-code': ['图转代码', '截图转页面'],
  'od-next-media-inputs': ['媒体素材', '准备素材'],

  // —— 演示与图示 ——
  'slides': ['slides', '演示', '幻灯片', 'html 演示'],
  'deck-guizang-editorial': ['杂志感幻灯片', '编辑风'],
  'deck-open-slide-canvas': ['自由画布幻灯片', '1920 画布'],
  'deck-swiss-international': ['瑞士风', '网格幻灯片'],
  'ppt-master': ['ppt', '做幻灯片', 'pptx'],
  'pptx-html-fidelity-audit': ['ppt 还原度', 'pptx 检查'],
  'diagram-design': ['架构图', '流程图', '示意图', '图表'],

  // —— 动效 ——
  'gsap-core': ['gsap', '补间动画', '缓动'],
  'gsap-timeline': ['时间线', '动画编排'],
  'gsap-scrolltrigger': ['滚动动画', '滚动特效', '视差'],
  'gsap-react': ['react 动画', 'usegsap'],
  'gsap-frameworks': ['vue 动画', 'svelte 动画'],
  'gsap-plugins': ['插件', 'splittext', 'draggable'],
  'gsap-performance': ['动画卡顿', '动画性能'],
  'gsap-utils': ['工具函数', 'clamp', 'maprange'],
  'review-animations': ['动效评审', '动画检查'],
  'frame-light-leak-cinema': ['漏光', '胶片感', '片头'],
  'frame-liquid-bg-hero': ['流体背景', '动态背景'],
  'chat-motion-overlay': ['聊天动效', '对话视频', '聊天记录', '气泡'],

  // —— 内容与运营 ——
  'aws-wechat-article-main': ['公众号一条龙', '写公众号', '发文全流程'],
  'aws-wechat-article-topics': ['选题', '起标题', '爆款'],
  'aws-wechat-article-writing': ['写稿', '公众号文章', '推文'],
  'aws-wechat-article-review': ['审稿', '错别字', '敏感词'],
  'aws-wechat-article-formatting': ['公众号排版', '微信排版', '美化'],
  'aws-wechat-article-images': ['封面图', '配图', '插图'],
  'aws-wechat-article-publish': ['发布', '群发', '草稿箱'],
  'aws-wechat-article-assets': ['素材库', '预设包'],
  'aws-wechat-sticker': ['贴图', '九宫格', '多图推送'],
  'research': ['调研', '查资料', '文献'],
  'research-decision-room': ['用户研究', '决策室', '访谈分析'],
  'audio-to-structured-notes': ['录音整理', '转写', '会议纪要', '录音'],
  'teach': ['教学', '讲解', '带新人'],

  // —— 文档与办公 ——
  'office': ['office', '文档', '办公文件'],
  'office-docx': ['word', 'docx', '写文档'],
  'office-xlsx': ['excel', 'xlsx', '表格'],
  'office-pptx': ['pptx', 'powerpoint', '演示文件'],
  'office-export-pdf': ['转pdf', '导出pdf', 'pdf'],
  'office-recalculate': ['公式重算', '刷新公式', 'excel 计算', 'excel', '公式'],
  'office-render': ['渲染文档', '文档预览'],
  'paper-digest-html': ['论文汇总', '文献面板', '论文网页'],

  // —— 工程与质量 ——
  'tdd': ['tdd', '测试驱动', '先写测试'],
  'code-review': ['代码评审', 'review 分支', '审查改动', '审查', 'pr'],
  'diagnosing-bugs': ['查bug', '调试', '排查问题', 'bug', '为什么崩', '崩溃'],
  'domain-modeling': ['领域模型', '统一语言'],
  'codebase-design': ['模块设计', '深模块'],
  'resolving-merge-conflicts': ['合并冲突', '解冲突'],
  'improve-codebase-architecture': ['架构改进', '重构建议'],
  'implement': ['开始实现', '照着计划做'],
  'to-spec': ['写规格', '需求转规格'],
  'to-tickets': ['拆票', '拆任务', '建 issue', '拆成票'],
  'triage': ['分类处理', '研判'],
  'wayfinder': ['拆解大任务', '路线规划'],
  'handoff': ['交接', '接手', '对话压缩'],
  'grilling': ['追问', '压力测试想法'],
  'grill-me': ['拷问我', '追问方案'],
  'grill-with-docs': ['带文档追问'],
  'ask-matt': ['问该用哪个技能', '路由'],
  'setup-matt-pocock-skills': ['初始化技能包'],

  // —— 评审与工具 ——
  'agent-browser': ['浏览器自动化', '打开网页', '截图抓取', '爬页面', '爬'],
  'brand-extract': ['提取品牌', '扒品牌', '取配色', '品牌'],
  'reverse-engineer-anything': ['逆向', '反编译', '拆二进制'],
  'high-perf-browser': ['网页性能', '首屏慢', 'core web vitals'],
  'deeptutor-cli': ['deeptutor', '教学系统'],
  'hindsight-coding-agent': ['记忆', 'hindsight', '知识页面'],
  'find-skills': ['找技能', '装技能', '有没有现成的', '现成'],
  'writing-great-skills': ['写技能', '改技能', 'skill 规范', '技能', 'skill'],
  'diagnose-windows-sandbox-acl': ['沙箱权限', 'acl 修复'],
};

/* ------------------------------------------------------------------ *
 * 2. 命名族默认词
 * ------------------------------------------------------------------ */

const FAMILY = [
  [/^office-/, ['office', '文档']],
  [/^aws-wechat-/, ['公众号', '微信']],
  [/^gsap-/, ['gsap', '动画']],
  [/^deck-/, ['幻灯片', '演示']],
  [/^imagegen-/, ['生图', '图像生成']],
  [/^frame-/, ['视觉框架', '片头']],
  [/^web-/, ['网页', '前端']],
  [/^ui-/, ['界面', 'ui']],
  [/^design-/, ['设计']],
  [/^code-/, ['代码']],
  [/^tdd$/, ['测试']],
  [/^research/, ['调研']],
  [/^ppt/, ['ppt']],
];

/* ------------------------------------------------------------------ *
 * 3. 从描述抽中文二元组（IDF 越高越独特）
 * ------------------------------------------------------------------ */

const STOP = new Set(
  '的了和与或把让在对从用按为是这一组个可需要支持用户使用时都就也不会要到现在进行以及并且可以如果已经用于适用当你提到当用户'.split('')
);

function bigrams(text) {
  const out = [];
  for (const run of text.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
    for (let i = 0; i + 2 <= run.length; i++) {
      const bg = run.slice(i, i + 2);
      if (STOP.has(bg[0]) || STOP.has(bg[1])) continue;
      out.push(bg);
    }
  }
  return out;
}

// 全库文档频次
const df = new Map();
for (const s of skills) {
  const seen = new Set(bigrams(`${s.name} ${s.desc || ''}`));
  for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
}
const N = skills.length;

function derived(skill) {
  const local = new Map();
  for (const t of bigrams(`${skill.name} ${skill.desc || ''}`)) local.set(t, (local.get(t) || 0) + 1);

  return [...local.entries()]
    .filter(([t]) => /^[\u4e00-\u9fa5]{2}$/.test(t))
    .map(([t, n]) => ({ t, n, idf: Math.log(N / (1 + (df.get(t) || 0))) }))
    .filter((x) => x.idf > 1.2)
    .sort((a, b) => b.n * b.idf - a.n * a.idf)
    .map((x) => x.t);
}

/* ------------------------------------------------------------------ *
 * 组装
 * ------------------------------------------------------------------ */

const result = {};
const report = [];

for (const s of skills) {
  const terms = [];

  const push = (t, allowShort) => {
    const v = String(t || '').trim().toLowerCase();
    if (!v) return;
    // 单字词只允许来自人工表（如「爬」「审」），自动派生一律要求 ≥2 字
    const minLen = allowShort ? 1 : 2;
    if (v.length < minLen || v.length > 16) return;
    if (terms.includes(v)) return;
    terms.push(v);
  };

  // 1. 人工
  for (const t of OVERRIDES[s.name] || []) push(t, true);

  // 2. 命名族
  for (const [re, list] of FAMILY) {
    if (re.test(s.name)) for (const t of list) push(t);
  }

  // 3. name token
  for (const tok of s.name.split('-')) {
    if (tok.length >= 3) push(tok);
  }

  // 4. 描述二元组（补到 4 个为止）
  for (const t of derived(s)) {
    if (terms.length >= 4) break;
    push(t);
  }

  // 保证至少 3 个
  let guard = 0;
  while (terms.length < 3 && guard < 3) {
    push(`${s.name}${guard || ''}`);
    guard++;
  }

  result[s.name] = terms.slice(0, 6);
  report.push({ name: s.name, count: result[s.name].length, terms: result[s.name] });
}

writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');

/* ---------------------------- 人工词表（curated） ---------------------------- */
// ranking 时人工词有 +30 加权，用来压过多个技能共享的泛词（界面/品牌/演示…）

const curated = {};
for (const [name, list] of Object.entries(OVERRIDES)) {
  curated[name] = list.map((t) => String(t).toLowerCase());
}
writeFileSync(join(HERE, 'curated.json'), JSON.stringify(curated, null, 2), 'utf8');

const counts = report.map((r) => r.count);
const total = counts.reduce((a, b) => a + b, 0);
console.log(`入口词表：${report.length} 个技能，共 ${total} 个词，平均 ${(total / report.length).toFixed(1)}`);
console.log(`分布：3词 ${counts.filter((c) => c === 3).length} · 4词 ${counts.filter((c) => c === 4).length} · 5词 ${counts.filter((c) => c === 5).length}`);
console.log('\n抽样（人工覆盖的 8 个）：');
for (const r of report.filter((x) => OVERRIDES[x.name]).slice(0, 8)) {
  console.log(`  ${r.name.padEnd(32)} ${r.terms.join(' / ')}`);
}
console.log('\n抽样（纯自动的 6 个）：');
for (const r of report.filter((x) => !OVERRIDES[x.name]).slice(0, 6)) {
  console.log(`  ${r.name.padEnd(32)} ${r.terms.join(' / ')}`);
}
console.log(`\n→ ${OUT}`);
