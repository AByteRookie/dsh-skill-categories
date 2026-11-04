/**
 * queries.mjs — 30 条真实中文意图 + 可接受的目标技能
 * 作为验收集：top1 / top3 命中率必须达标才算方案 A 成立。
 */

export const QUERIES = [
  { q: '做一份演示文稿', targets: ['slides', 'ppt-master', 'deck-guizang-editorial', 'deck-open-slide-canvas', 'deck-swiss-international'] },
  { q: '把pdf转成word', targets: ['office-export-pdf', 'office-docx'] },
  { q: '给页面加滚动动画', targets: ['gsap-scrolltrigger', 'gsap-core', 'gsap-timeline'] },
  { q: '写一篇公众号文章', targets: ['aws-wechat-article-writing', 'aws-wechat-article-main'] },
  { q: '审一下这个界面', targets: ['ux-heuristics', 'web-design-optimization', 'steve-jobs-design-review', 'refactoring-ui'] },
  { q: '做个落地页', targets: ['landing-page-design-hard-rules'] },
  { q: '复刻这个网站', targets: ['web-clone'] },
  { q: '给网站配色', targets: ['refactoring-ui', 'web-ui-design', 'ui-ux-pro-max', 'design-system'] },
  { q: '做一张架构图', targets: ['diagram-design'] },
  { q: '生成产品主图', targets: ['ecommerce-image-workflow', 'imagegen-frontend-web'] },
  { q: '做个 iPhone 样机', targets: ['mockup-device-3d'] },
  { q: '爬一下这个页面', targets: ['agent-browser'] },
  { q: '提取这个站的品牌', targets: ['brand-extract'] },
  { q: '拆解这个逆向目标', targets: ['reverse-engineer-anything'] },
  { q: '写一个技能', targets: ['writing-great-skills'] },
  { q: '找找有没有现成技能', targets: ['find-skills'] },
  { q: '用 TDD 写', targets: ['tdd'] },
  { q: '审查我的分支', targets: ['code-review'] },
  { q: '这个 bug 查一下', targets: ['diagnosing-bugs'] },
  { q: '建领域模型', targets: ['domain-modeling'] },
  { q: '把大任务拆成票', targets: ['to-tickets', 'wayfinder'] },
  { q: '接手别人的活', targets: ['handoff'] },
  { q: '校验 Excel 公式', targets: ['office-recalculate', 'office-xlsx'] },
  { q: '把文档转 PDF', targets: ['office-export-pdf'] },
  { q: '做一张海报', targets: ['banner-design', 'design'] },
  { q: '加个按钮微交互', targets: ['microinteractions'] },
  { q: '字体怎么选', targets: ['web-typography'] },
  { q: '做个多图推送', targets: ['aws-wechat-sticker'] },
  { q: '访谈录音整理', targets: ['audio-to-structured-notes'] },
  { q: '论文汇总做成网页', targets: ['paper-digest-html'] },
];
