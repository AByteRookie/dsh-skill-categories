/**
 * taxonomy.mjs — 分类体系定义与打分（供 build / apply / explain 共用）
 *
 * 权重约定：
 *   26     命名前缀（作者显式声明的家族，压过描述里的泛词）
 *   8..10  强特征（专有名词、领域术语）
 *   4..7   中等特征（典型动作或对象）
 *   1..3   弱特征（沾边通用词，仅用于打破平局）
 */

export const MIN_SCORE = 3;
export const ALT_RATIO = 1.6;
export const PROMOTE_THRESHOLD = 5;
export const NAME_BOOST = 1.6;
export const STRONG_NAME_BONUS = 26;

/**
 * 升格阈值必须随语料规模变化。
 *
 * 固定 5 在小语料下是死循环：全库只有 8 个技能时，任何新簇都凑不到 5 个，
 * misc 缓冲池变成黑洞，永远不会提案新类。
 *
 * 规则（设计推断，非论文）：max(2, round(N * 0.06))
 *   114 个 → 7（与原来的 5 同量级）
 *    33 个 → 2
 *     8 个 → 2（仍可触发）
 */
export function promoteThreshold(totalSkills) {
  const n = Number(totalSkills) || 0;
  if (n < 5) return Infinity; // 太少，本来就不该分层
  return Math.max(2, Math.round(n * 0.06));
}

export const TAXONOMY = [
  {
    id: 'style',
    label: '风格与审美',
    glyph: '◐',
    order: 10,
    blurb: '决定界面「长什么样」：美术方向、视觉语言、反套路',
    strongName: [/^gpt-taste/, /^taste-skill/, /^design-taste/],
    rules: [
      { re: /(visual-design|aesthetic|minimalist|brutalist|editorial|swiss)/i, w: 9 },
      { re: /(风格|美学|审美|视觉语言|美术方向|调性|质感)/, w: 7 },
      { re: /(高端|高级质感|昂贵|不廉价|通用套路|反\s*AI\s*套路|模板化|不像模板)/, w: 6 },
      { re: /(taste|design-taste|gpt-taste)/i, w: 9 },
      { re: /(hallmark|frontend-design|top-design|stitch)/i, w: 8 },
      { re: /(parchment|kami|纸色|暖纸|衬线|单色)/i, w: 8 },
      { re: /(字体|字族|排版|配色|色板|版式|画布)/, w: 4 },
      { re: /#[0-9a-f]{6}/i, w: 3 },
      { re: /(品牌识别|视觉识别|品牌套件|识别系统)/, w: 4 },
      { re: /(Awwwards|获奖级|沉浸式)/i, w: 6 },
    ],
  },
  {
    id: 'ui',
    label: '界面实现',
    glyph: '▤',
    order: 20,
    blurb: '把设计落到代码：组件、令牌、间距、字体、微交互',
    strongName: [/^refactoring-ui$/, /^ui-styling$/, /^web-typography$/, /^microinteractions$/, /^design-system$/, /^interface-design(-v\d+)?$/],
    rules: [
      { re: /(ui-styling|refactoring-ui|web-typography|microinteraction|design-system)/i, w: 10 },
      { re: /(shadcn|tailwind|design token|设计令牌|组件规范)/i, w: 9 },
      { re: /(间距|圆角|阴影|视觉层级|层次感|字号尺度|行高|字重)/, w: 6 },
      { re: /(微交互|按钮反馈|加载状态|状态转场|输入反馈|骨架屏)/, w: 7 },
      { re: /(响应式|可访问|无障碍|a11y|对比度)/, w: 4 },
      { re: /(^|\W)(UI|界面|组件)(\W|$)/i, w: 3 },
      { re: /(设计系统|样式|styling)/i, w: 3 },
    ],
  },
  {
    id: 'review',
    label: '评审与审计',
    glyph: '⚖',
    order: 30,
    blurb: '按标准挑毛病：可用性、视觉、动效、代码架构',
    strongName: [/^review-/, /^steve-jobs/, /^ux-heuristics$/],
    rules: [
      { re: /(评审|审计|审查|挑刺|复核|走查)/, w: 8 },
      { re: /(review|audit|heuristic)/i, w: 8 },
      { re: /(可用性|启发式|认知走查|Nielsen|Krug)/i, w: 8 },
      { re: /(steve-jobs|乔布斯)/i, w: 9 },
      { re: /(问题清单|修改清单|严重度|分级)/, w: 5 },
    ],
  },
  {
    id: 'page',
    label: '页面与站点',
    glyph: '▭',
    order: 40,
    blurb: '从零建页、改版、复刻：落地页、FAQ 页、站点克隆',
    strongName: [/^landing-page/, /^redesign-/, /^web-clone$/, /^faq-page$/, /^banner-design$/],
    rules: [
      { re: /(landing|落地页|营销站|官网|主页)/i, w: 8 },
      { re: /(web-clone|复刻|克隆|clone|仿站|抄个站)/i, w: 10 },
      { re: /(redesign|改版|升级到|重构现有)/i, w: 8 },
      { re: /(faq|帮助中心|常见问题)/i, w: 9 },
      { re: /(页面结构|转化|CTA|首屏)/, w: 5 },
      { re: /(banner|横幅)/i, w: 7 },
      { re: /(prototype|原型)/i, w: 5 },
    ],
  },
  {
    id: 'image',
    label: '图像生成',
    glyph: '◨',
    order: 50,
    blurb: '出图：AI 生图、电商图、品牌板、样机、宠物精灵图',
    strongName: [/^imagegen-/, /^brandkit$/, /^hatch-pet$/, /^mockup-/, /^ecommerce-image/, /^image-to-code$/],
    rules: [
      { re: /(imagegen|图像生成|生图|AI\s*生图|出图)/i, w: 10 },
      { re: /(ecommerce-image|电商|主图|卖点图|场景图)/i, w: 9 },
      { re: /(brandkit|品牌套件图像|logo\s*系统)/i, w: 8 },
      { re: /(mockup|样机|3D\s*风格|转台)/i, w: 8 },
      { re: /(hatch-pet|精灵图|雪碧图|spritesheet)/i, w: 10 },
      { re: /(配图|插图|封面)/, w: 5 },
      { re: /(image-to-code|图转代码)/i, w: 7 },
      { re: /(媒体输入|素材|图片素材)/, w: 6 },
    ],
  },
  {
    id: 'deck',
    label: '演示与图示',
    glyph: '▦',
    order: 60,
    blurb: '幻灯片、PPTX、图示与图表',
    strongName: [/^deck-/, /^slides$/, /^ppt-/, /^pptx-/, /^diagram-design$/],
    rules: [
      { re: /(deck|slide|幻灯片|演示|presentation|pptx|ppt)/i, w: 9 },
      { re: /(图示|图表|架构图|流程图|时序图|桑基|甘特|diagram)/i, w: 9 },
      { re: /(版式|网格|画布)/, w: 3 },
    ],
  },
  {
    id: 'motion',
    label: '动效与动画',
    glyph: '◔',
    order: 70,
    blurb: 'GSAP 全家桶、滚动叙事、动效评审、视觉框架',
    strongName: [/^gsap-/, /^frame-/, /^chat-motion/],
    rules: [
      { re: /(gsap|scrolltrigger|timeline|tween)/i, w: 10 },
      { re: /(动效|动画|转场|motion|animation)/i, w: 7 },
      { re: /(滚动|视差|钉住|scrub|stagger|缓动)/, w: 6 },
      { re: /(frame-light|frame-liquid|漏光|流体位移|遮幅)/i, w: 8 },
      { re: /(chat-motion|Remotion|动效叠加)/i, w: 9 },
    ],
  },
  {
    id: 'wechat',
    label: '公众号运营',
    glyph: '◈',
    order: 80,
    blurb: '选题、写稿、审稿、排版、配图、发布一条龙',
    strongName: [/^aws-wechat-/],
    rules: [
      { re: /(公众号|微信|wechat|自媒体)/i, w: 10 },
      { re: /(aws-wechat)/i, w: 10 },
      { re: /(草稿箱|群发|图文推送|贴图|九宫格|多图推送)/, w: 8 },
      { re: /(选题|爆款|标题|摘要|敏感词)/, w: 4 },
    ],
  },
  {
    id: 'office',
    label: '办公文档',
    glyph: '▣',
    order: 90,
    blurb: 'Word / Excel / PowerPoint / PDF 的读写校验',
    strongName: [/^office/],
    rules: [
      { re: /(docx|xlsx|LibreOffice|公式缓存)/i, w: 8 },
      { re: /(表格|工作簿|文档|重算|formula cache)/, w: 3 },
      { re: /(paper-digest|论文汇总|汇总文档)/i, w: 7 },
      { re: /(Word documents?|Excel workbooks?|PowerPoint presentations?)/i, w: 9 },
    ],
  },
  {
    id: 'research',
    label: '研究与写作',
    glyph: '◍',
    order: 100,
    blurb: '调研、访谈分析、录音转写、教学与知识产出',
    strongName: [/^research/, /^audio-to-/, /^teach$/],
    rules: [
      { re: /(research|调研|一手来源|证据台账)/i, w: 9 },
      { re: /(访谈|录音|转写|transcri|ASR)/i, w: 9 },
      { re: /(用户研究|决策室|问卷|工单)/, w: 8 },
      { re: /(teach|教学|教用户|讲解)/i, w: 7 },
      { re: /(Markdown\s*文件|知识产出|笔记)/, w: 3 },
    ],
  },
  {
    id: 'eng',
    label: '编码与质量',
    glyph: '⌘',
    order: 110,
    blurb: 'TDD、代码评审、诊断、领域建模、模块设计',
    strongName: [
      /^tdd$/,
      /^code-review$/,
      /^diagnosing-/,
      /^domain-modeling$/,
      /^codebase-design$/,
      /^improve-codebase/,
      /^resolving-merge/,
    ],
    rules: [
      { re: /(test-driven|TDD|红-绿-重构)/i, w: 10 },
      { re: /(code-review|代码评审)/i, w: 9 },
      { re: /(debug|diagnos|诊断|调试|根因)/i, w: 9 },
      { re: /(domain-modeling|领域模型|统一语言|架构决策|ADR)/i, w: 8 },
      { re: /(deep module|深模块|模块接口|接缝|可测试)/i, w: 8 },
      { re: /(merge|rebase|冲突)/i, w: 8 },
      { re: /(代码库|codebase|重构)/i, w: 5 },
    ],
  },
  {
    id: 'flow',
    label: '规划与协作',
    glyph: '⇄',
    order: 120,
    blurb: '把大工作拆成票、追问打磨、交接与推进',
    strongName: [
      /^(to-spec|to-tickets|triage|wayfinder|handoff|implement|grill|grilling)/,
      /^ask-matt$/,
      /^setup-matt/,
    ],
    rules: [
      { re: /(ticket|issue|跟踪器|triage)/i, w: 9 },
      { re: /(to-spec|to-tickets|wayfinder|handoff|implement)/i, w: 10 },
      { re: /(grill|追问|穷追猛打|压力测试)/i, w: 9 },
      { re: /(规划|拆成|拆解|阻塞边|决策)/, w: 5 },
      { re: /(交接|压缩成|接着做)/, w: 7 },
      { re: /(路由入口|工作流)/, w: 4 },
    ],
  },
  {
    id: 'career',
    label: '求职与职业',
    glyph: '◈',
    order: 125,
    blurb: '简历、求职信、面试、offer 谈判、职业转型',
    strongName: [
      /^(resume|academic-cv|career-)/,
      /-(resume|cv)$/,
      /^(interview-prep|mock-interview|offer-negotiation|linkedin-profile-writer)$/,
      /^(job-application-manager|cover-letter-writer|application-answers|accomplishment-inventory)$/,
      /^portfolio-case-study$/,
      /^get-jobs$/,
    ],
    rules: [
      { re: /(简历|履历|求职|找工作|应聘|投递|招聘|岗位|面试|谈薪|薪酬|职业转型|转行|猎头)/, w: 9 },
      {
        re: /(resume|curriculum vitae|\bcv\b|cover letter|job application|interview|hiring|recruiter)/i,
        w: 9,
      },
      { re: /(career|job search|offer negotiation|salary|compensation)/i, w: 8 },
      { re: /(linkedin|ats|求职信|作品集)/i, w: 7 },
      { re: /(portfolio case study|面试准备|行为面试|招聘流程)/i, w: 6 },
    ],
  },
  {
    id: 'tools',
    label: '工具与集成',
    glyph: '⚙',
    order: 130,
    blurb: '浏览器自动化、抓取、逆向、CLI 接入、技能管理、沙箱诊断',
    strongName: [
      /^agent-browser$/,
      /^brand-extract$/,
      /^reverse-engineer/,
      /^deeptutor-/,
      /^hindsight-/,
      /^find-skills$/,
      /^writing-great-skills$/,
      /^diagnose-windows-sandbox-acl$/,
      /-cli-calling$/,
      /^memory-consolidate$/,
    ],
    rules: [
      { re: /(browser|浏览器|CDP|抓取|爬|截屏|screenshot)/i, w: 8 },
      { re: /(brand-extract|提取品牌|Brand Kit)/i, w: 8 },
      { re: /(reverse|逆向|反编译|固件|二进制)/i, w: 10 },
      { re: /(deeptutor|CLI|命令行|插件|plugin)/i, w: 6 },
      { re: /(find-skills|writing-great-skills|skill 的参考|发现并安装)/i, w: 10 },
      { re: /(记忆|memory|hindsight|知识页面)/i, w: 7 },
      { re: /(sandbox|沙箱|ACL|denial)/i, w: 8 },
      { re: /(MCP|接入|集成)/i, w: 4 },
      // 各家的 CLI「不进交互界面直接调用」技能：codex / grok / kimi / hermes 一族
      { re: /(-cli-calling|命令行直接调用|non-interactive|不进交互)/i, w: 9 },
    ],
  },
];

/**
 * 英文规则层（独立表，与 TAXONOMY.rules 合并参与打分）
 *
 * 为什么需要：原规则几乎全是中文词。用 50 个 GitHub 下载的英文技能实测，
 * 40% 得 0 分掉进 misc —— 不是这些技能无法归类，而是规则读不懂英文。
 *
 * ⚠️ key 必须是 TAXONOMY 的 facet id（office / image / review / tools …），
 * 不是 display 的展示类 id（doc / visual / review-tool）。写错会静默失效。
 *
 * 写法约束：
 *   · 只匹配短语，不匹配 bare 单词（避免 design / image / skill 这类泛词误伤）
 *   · 权重整体低于中文规则，做兜底而不是抢主导
 */
export const EN_RULES = {
  style: [
    { re: /(brand[- ]?guide|brand colors|brand identity|visual identity|art direction)/i, w: 8 },
    { re: /(typography|font pairing|palette|aesthetic|minimalist|brutalist|editorial design)/i, w: 5 },
    // 「给产物套主题」的工具（如 theme-factory）描述里常提到 landing pages，
    // 会被页面规则误抓；用更具体的主语压过去。
    { re: /(apply a theme|styling artifacts|theme factory|pre-?set themes)/i, w: 9 },
  ],
  ui: [
    { re: /(design system|design token|component library|shadcn|tailwind)/i, w: 7 },
    { re: /(accessibility|responsive layout|component specification)/i, w: 5 },
  ],
  page: [
    { re: /(landing page|marketing site|conversion|seo|search optimization)/i, w: 7 },
    { re: /(internationaliz|multi-language|i18n|next\.?js website|web app)/i, w: 6 },
  ],
  image: [
    { re: /(p5\.?js|generative art|visual art|illustration|image generation)/i, w: 8 },
    // 不匹配裸 "mockup"：综合设计类技能（如 design）描述里也会提到 CIP mockup，
    // 会被误拉进图像类（实测已发生）。mockup-device-3d 由中文规则覆盖。
    { re: /(canvas|sprite)/i, w: 5 },
  ],
  deck: [
    { re: /(slide deck|presentation|powerpoint|pptx)/i, w: 8 },
  ],
  motion: [
    // 只用强动作词；不匹配裸 "gsap" —— 中文设计类描述里常提到「GSAP 动效编排」，
    // 会把 web-ui-design / ui-ux-pro-max 误拖进动效类（实测已发生）。
    { re: /(animation|animate|scroll-triggered|transition)/i, w: 7 },
  ],
  wechat: [
    { re: /(article|blog post|newsletter|copywriting|publish|twitter|x article)/i, w: 7 },
    // 内部沟通类（status reports / announcement / 3P updates）在多类平局时
    // 会被体系顺序仲裁进「页面与转化」，用更具体的主语拉回内容类。
    { re: /(internal comms|internal communications|status report|announcement|incident report)/i, w: 9 },
  ],
  research: [],
  office: [
    // office-* 必须整族留在「文档与办公」：英文 pptx/presentation 会把 office-pptx
    // 单独拉进演示类，菜单里就和 docx/xlsx 分家（实测已发生）。
    { re: /^office(\s|$)/i, w: 15 },
    { re: /(pdf manipulation|pdf toolkit|docx|xlsx|spreadsheet|obsidian|json canvas|markdown (file|editor))/i, w: 8 },
    { re: /(pdf|document|co-?authoring)/i, w: 4 },
  ],
  eng: [
    { re: /(deploy|ci\/cd|github|release note|refactor|pull request|code review)/i, w: 7 },
    { re: /(unit test|tdd|debug|specification|writing plans?|implementation plan)/i, w: 6 },
  ],
  flow: [
    { re: /(roadmap|milestone|backlog|handoff|parallel agents|dispatch)/i, w: 6 },
  ],
  review: [
    { re: /(audit|verification|review checklist|heuristic evaluation)/i, w: 7 },
  ],
  tools: [
    { re: /(mcp server|api integration|skill[- ]creator|writing skills?|using superpowers)/i, w: 7 },
  ],
};

/** 对单个技能打分并给出分类判定 */
export function scoreSkill(skill) {
  const name = skill.name || '';
  const desc = skill.desc || '';
  const hayName = name.replace(/-/g, ' ');
  const rows = [];

  for (const cat of TAXONOMY) {
    let score = 0;
    const hits = [];

    for (const pat of cat.strongName || []) {
      if (pat.test(name)) {
        score += STRONG_NAME_BONUS;
        hits.push({ where: 'strong-name', w: STRONG_NAME_BONUS, re: String(pat) });
      }
    }
    for (const rule of cat.rules.concat(EN_RULES[cat.id] || [])) {
      if (rule.re.test(desc)) {
        score += rule.w;
        hits.push({ where: 'desc', w: rule.w, re: String(rule.re) });
      }
      if (rule.re.test(hayName)) {
        const w = Math.round(rule.w * NAME_BOOST * 10) / 10;
        score += w;
        hits.push({ where: 'name', w, re: String(rule.re) });
      }
    }
    if (score > 0) rows.push({ id: cat.id, score, hits });
  }

  rows.sort((a, b) => b.score - a.score);
  const top = rows[0];
  const second = rows[1];
  const total = rows.reduce((s, r) => s + r.score, 0) || 1;

  let category = 'misc';
  let tier = 'low';
  let confidence = 0;
  let reason = '';

  if (top && top.score >= MIN_SCORE) {
    category = top.id;
    const ratio = second ? top.score / second.score : Infinity;
    confidence = Math.round((top.score / total) * 100) / 100;

    if (top.hits.some((h) => h.where === 'strong-name')) {
      tier = 'high';
      reason = '命名前缀直接声明了家族';
    } else if (ratio >= 2 && top.score >= 10) {
      tier = 'high';
      reason = '得分显著领先';
    } else if (ratio >= 1.3) {
      tier = 'medium';
      reason = '领先但存在跨域信号';
    } else {
      tier = 'medium';
      reason = '多类接近，按体系优先级仲裁主类';
    }
  } else {
    reason = '无任何规则命中，落 misc 等待人工定夺';
  }

  const altCategories = top && second && top.score / second.score < ALT_RATIO ? [second.id] : [];

  return {
    category,
    tier,
    confidence,
    score: top ? top.score : 0,
    reason,
    altCategories,
    ranked: rows.slice(0, 3),
  };
}

export const CAT_MAP = new Map(TAXONOMY.map((t) => [t.id, t]));
