/**
 * verify-client.mjs — 对**已安装的** client.js 做端到端行为验证
 *
 * 不复制代码、不 mock 掉逻辑：直接加载
 *   ~/.dsh/local-plugins/dsh-skill-categories/lib/client.js
 * 给它一个仿真的 __ModuleLoader__ / window / ctx / inputTriggers，其中
 * 内置技能源按 asar 里的真实实现复刻：
 *   candidates(session, { query, signal }) → rankByName(skills, query).map(s => ({name, description}))
 *
 * 然后断言：
 *   1. 空查询：每个候选项都带 section，且按分类 order 排列，组内按名称排序
 *   2. 非空查询：完全透传（不加 section、不重排），保持相关度
 *   3. 未知技能：落「· 其他」
 *   4. 内置源晚于插件注册：轮询能补上
 *   5. dispose 后恢复原始 candidates
 *
 * 最后用 asar 里渲染器的真实判据模拟一遍菜单输出：
 *   item.section !== undefined && item.section !== prev?.section → 插入标题
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { pluginDir } from './paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// 插件位置走公共解析（尊重 DSH_HOME）：preflight / CI 会把插件生成到临时目录，
// 这里若硬读 homedir() 就会验到「上一次装的那份」，等于自欺。
const CLIENT = join(pluginDir(), 'lib', 'client.js');

// 这份用例的断言建立在「开发者本机技能库」的数据分布上（152 条 / 148 可见）。
// 别人 clone 下来跑时数据不同，不能因此判红 —— 但必须显式声明跳过，不能装作通过。
const REF_MARK = ['gsap-core', 'tdd', 'code-review'];
function skipIfNoReferenceDataset(loaded) {
  const names = new Set((loaded.skills || []).map((s) => s.name));
  if (REF_MARK.some((n) => names.has(n))) return false;
  console.log('\nSKIP: 当前 index.json 不含基准数据集（开发者的技能库）');
  console.log('      这份用例校验的是分类/排序在特定数据分布下的行为；');
  console.log('      你的技能库不同，断言 148 条、设计 23 类这类期望不适用。');
  console.log('      安装本身不受影响：node setup.mjs 已成功即为可用。');
  return true;
}

// 自检要能证明「验的是哪份文件」：路径 + 哈希都打出来
if (!existsSync(CLIENT)) {
  console.error('找不到客户端 bundle：' + CLIENT);
  console.error('先跑 node setup.mjs（或 pack.mjs）生成插件。');
  process.exit(2);
}
const CLIENT_SHA = createHash('sha256').update(readFileSync(CLIENT)).digest('hex');
console.log('客户端 bundle: ' + CLIENT);
console.log('  sha256 ' + CLIENT_SHA);

const idx = JSON.parse(readFileSync(join(HERE, 'index.json'), 'utf8').replace(/^\uFEFF/, ''));
if (skipIfNoReferenceDataset(idx)) process.exit(0);

const labelOf = new Map(idx.taxonomy.map((t) => [t.id, `${t.glyph} ${t.label}`]));
const orderOf = new Map(idx.taxonomy.map((t) => [t.id, t.order]));

/* ---------------------------- 仿真宿主 ---------------------------- */

// 技能目录：与真实 skills/list 同形。
// 只取 userInvocable —— 菜单里本来就不显示 model-only 技能，
// 把它们算进来会让「misc 只有 2 条」的碎组判定失真（真实菜单里 misc 是 0 条）。
const SKILLS = idx.skills
  .filter((s) => s.userInvocable)
  .map((s) => ({
    name: s.name,
    description: s.desc || '',
    modelInvocable: true,
  }));

/** 复刻 ui-primitives 的 rankByName：有序子序列 + 前缀优先（够用即可） */
function rankByName(skills, query) {
  if (!query) return skills.slice();
  const q = query.toLowerCase();
  const scored = [];
  for (const s of skills) {
    const n = s.name.toLowerCase();
    if (n.startsWith(q)) { scored.push({ s, score: 1000 - n.length }); continue; }
    let i = 0;
    for (let j = 0; j < n.length && i < q.length; j++) if (n[j] === q[i]) i++;
    if (i === q.length) scored.push({ s, score: 200 - n.length });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((x) => x.s);
}

/** 复刻内置技能源（trigger "/" name "skill"）的 candidates；list 可覆盖技能目录 */
function makeBuiltinSource(list) {
  const catalog = list || SKILLS;
  const calls = [];
  return {
    trigger: '/',
    name: 'skill',
    order: 2,
    async candidates(session, req) {
      const { query = '', signal } = req || {};
      calls.push(query);
      if (signal && signal.aborted) return [];
      return rankByName(catalog, query).map((skill) => ({
        name: skill.name,
        description: skill.modelInvocable ? skill.description : `用户专用 · ${skill.description}`,
      }));
    },
    onPick({ candidate }) { return { text: `/${candidate.name} ` }; },
    __calls: calls,
  };
}

/* ---------------------------- 加载真实 bundle ---------------------------- */

const src = readFileSync(CLIENT, 'utf8');
let captured = null;

// 可观测的 localStorage：埋点必须真的能落进存储，离线测试才有意义
const store = new Map();
const fakeWindow = {
  __ModuleLoader__: { load: (cfg) => { captured = cfg; } },
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  },
};

// 浏览器里这个 bundle 是被当普通脚本求值的：全局作用域只有 window，
// **没有 module / exports / require**。loader 只把 require 传给 factory，
// module / exports 必须由 factory 自己声明。
// 这里严格照此复刻 —— 早期版本错误地喂了 module/exports，才漏掉了这个致命 bug。
new Function('window', src)(fakeWindow);

if (!captured || typeof captured.factory !== 'function') {
  console.error('✗ bundle 没有登记 factory');
  process.exit(1);
}
if (captured.id !== 'dsh-skill-categories') {
  console.error('✗ bundle id 不符:', captured.id);
  process.exit(1);
}

const api = captured.factory((name) => {
  throw new Error('不应 require 任何模块，实际请求: ' + name);
});
if (!api || typeof api.apply !== 'function') {
  console.error('✗ factory 没有导出 apply');
  process.exit(1);
}

/* ---------------------------- 断言工具 ---------------------------- */

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? '  → ' + extra : ''}`); }
}

/* ---------------------------- 测试 1：正常挂载 ---------------------------- */

console.log('\n[1] 空查询：分组是否正确');

const builtin = makeBuiltinSource();
// 记录包装前的原始函数，dispose 后必须逐字节还原成这两个引用
const beforeCandidates = builtin.candidates;
const beforePick = builtin.onPick;
const sources = [builtin];
const svc = { live: { sources } };
const ctx = {
  get: (name) => (name === 'inputTriggers' ? svc : undefined),
  inject: (deps, cb) => cb({ get: ctx.get }),
  effect: (fn) => { const d = fn(); return () => d && d(); },
};

api.apply(ctx);
await new Promise((r) => setTimeout(r, 600));

ok(builtin.__skillCategories !== undefined, '内置源已被标记为已包装');
ok(api.inject !== undefined, 'exports.inject 存在');

const items = await builtin.candidates({ sessionId: 's1' }, { query: '', signal: { aborted: false } });

ok(items.length === SKILLS.length, `候选项数量不变（${items.length}/${SKILLS.length}）`);
ok(items.every((i) => typeof i.section === 'string'), '每一项都有 section');
ok(
  items.every((i) => i.description !== undefined),
  '原有 description 字段被保留'
);

// 顺序：section 的 order 单调不减；同组内名称升序
let ordered = true;
let prevOrder = -1;
for (const it of items) {
  const catId = idx.skills.find((s) => s.name === it.name)?.category;
  const o = catId ? orderOf.get(catId) ?? 999 : 999;
  if (o < prevOrder) ordered = false;
  prevOrder = o;
}
ok(ordered, '整体按分类 order 升序排列');

let withinSorted = true;
for (let i = 1; i < items.length; i++) {
  // 必须用与实现相同的 localeCompare：< 是码点比较，会被大小写/连字符排出不同顺序
  if (items[i].section === items[i - 1].section && items[i].name.localeCompare(items[i - 1].name) < 0) withinSorted = false;
}
ok(withinSorted, '同组内按名称升序');

// section 文案 = 分类表文案 + 「 · 数量」后缀
const sectionSet = new Set(items.map((i) => i.section));
const prefixOf = (s) => String(s).replace(/ · \d+$/, '');
const expectedSet = new Set([...labelOf.values(), '· 未归类']);
const unexpected = [...sectionSet].filter((s) => !expectedSet.has(prefixOf(s)));
ok(unexpected.length === 0, 'section 文案全部来自分类表（带数量后缀）', unexpected.join(','));
const noCount = [...sectionSet].filter((s) => !/ · \d+$/.test(String(s)));
ok(noCount.length === 0, '每个分组标题都带数量', noCount.join(','));

/* ---------------------------- 测试 2：搜索透传 ---------------------------- */

console.log('\n[2] 非空查询：应完全透传（保持相关度）');

const qItems = await builtin.candidates({ sessionId: 's1' }, { query: 'gsap', signal: { aborted: false } });
const expected = rankByName(SKILLS, 'gsap').map((s) => ({ name: s.name, description: s.description }));

ok(qItems.length >= expected.length && expected.every((e) => qItems.some((i) => i.name === e.name)), `内置结果全部保留且不减少（${qItems.length} ≥ ${expected.length}）`);
ok(
  qItems.every((i) => i.section === undefined),
  '搜索时不注入 section（不干扰相关度排序）'
);
/* ---------------------------- 测试 2b：中文本地排序 ---------------------------- */

// 内置 rankByName 对中文意图命中为 0；插件接管后应能命中。
const cn = await builtin.candidates({ sessionId: 's1' }, { query: '做个落地页', signal: { aborted: false } });
ok(cn.length > 0, `中文意图有结果（${cn.length} 条）`);
ok(cn[0] && cn[0].name === 'landing-page-design-hard-rules', '中文意图 top1 = 落地页技能', cn[0] && cn[0].name);
ok(
  cn.every((i) => i.section === undefined),
  '中文查询同样不注入 section'
);

/* ---------------------------- 测试 2c：单字母中途输入 ---------------------------- */

// 真实埋点显示输入 "r" 时本地排序返回 0 条（本地要求 ≥2 字）。
// 修复后应由内置模糊结果补回召回。
const one = await builtin.candidates({ sessionId: 's1' }, { query: 'r', signal: { aborted: false } });
ok(one.length > 0, `单字母输入有召回（${one.length} 条）`);

/* ---------------------------- 测试 3：未知技能 ---------------------------- */

console.log('\n[3] 未收录的技能应落「· 未归类」');

SKILLS.push({ name: 'totally-unmapped-skill', description: '测试用', modelInvocable: true });
const items3 = await builtin.candidates({ sessionId: 's1' }, { query: '', signal: { aborted: false } });
const unknown = items3.find((i) => i.name === 'totally-unmapped-skill');
ok(unknown && String(unknown.section).indexOf('· 未归类') === 0, '未知技能归入「· 未归类」', unknown && unknown.section);
SKILLS.pop();

/* ---------------------------- 测试 4：晚注册 ---------------------------- */

console.log('\n[4] 内置源晚于插件注册：轮询应补上');

const lateSvc = { live: { sources: [] } };
const lateCtx = {
  get: () => lateSvc,
  inject: (d, cb) => cb({ get: () => lateSvc }),
  effect: (fn) => fn(),
};
api.apply(lateCtx);
await new Promise((r) => setTimeout(r, 200));

const lateSource = makeBuiltinSource();
lateSvc.live.sources.push(lateSource);
await new Promise((r) => setTimeout(r, 700));

ok(lateSource.__skillCategories !== undefined, '晚到的源在 1s 内被包装');

/* ---------------------------- 测试 5：卸载还原 ---------------------------- */

console.log('\n[5] dispose / 还原');

const disposeFn = api.dispose;
ok(typeof disposeFn === 'function', 'exports.dispose 存在');

// 评测批评：旧测试自己把 candidates 还原了，等于替实现完成了工作。
// 现在只调用公开生命周期接口，观察最终状态。
api.dispose();
ok(builtin.candidates === beforeCandidates, 'dispose 后 candidates 已还原为原函数');
ok(builtin.onPick === beforePick, 'dispose 后 onPick 已还原为原函数');
ok(builtin.__skillCategories === undefined, 'dispose 后包装标记已移除');
const restored = await builtin.candidates({ sessionId: 's1' }, { query: '', signal: { aborted: false } });
ok(restored.every((i) => i.section === undefined), 'dispose 后不再注入 section');

/* ---------------------------- 测试 5b：跨会话归因 ---------------------------- */

console.log('\n[5b] 两个会话并发，选中归因不应串线');

// 重新挂载一份干净环境（带可观测的 localStorage）
const s2 = makeBuiltinSource();
const before2 = s2.candidates;
api.apply({
  get: () => ({ live: { sources: [s2] } }),
  inject: (d, cb) => cb({ get: () => ({ live: { sources: [s2] } }) }),
  effect: (fn) => fn(),
});
await new Promise((r) => setTimeout(r, 500));

const sessA = { id: 'A' };
const sessB = { id: 'B' };
await s2.candidates(sessA, { query: 'tdd', signal: {} });
await s2.candidates(sessB, { query: 'gsap', signal: {} });

// B 会话选中 gsap-core：名次应按 B 的结果算，而不是沿用 A 的
const gsapList = await s2.candidates(sessB, { query: 'gsap', signal: {} });
const gsapRank = gsapList.findIndex((x) => x.name === 'gsap-core');
s2.onPick({ session: sessB, candidate: { name: 'gsap-core' } });
const events = JSON.parse(api.diagnostics.export());
const last = events.filter((e) => e.pick === 'gsap-core').pop();
ok(
  last && last.rank === gsapRank && last.q === 'gsap',
  '归因取的是本会话的结果',
  last ? `rank=${last.rank}/${gsapRank} q=${last.q}` : '无事件'
);

/* ---------------------------- 测试 5b2：语义层降级 ---------------------------- */

console.log('\n[5b2] 模型不可用时必须安静降级');

// 浏览路径不再触发语义加载（那会卡菜单），这里显式启动一次，验证 import 失败时的降级。
await s2.candidates(sessA, { query: '', signal: {} });
api.diagnostics.semanticWarm(SKILLS.map((s) => ({ name: s.name, description: s.description })));
await new Promise((r) => setTimeout(r, 1200));
const semState = api.diagnostics.semanticStatus();
ok(
  semState.status === 'unavailable',
  '无法 import 远程模型 → 状态置为 unavailable（不抛错、不阻塞）',
  semState.error || ''
);
// builtin 已在测试 5 被 dispose，这里重新挂一个干净源
const fbSrc = makeBuiltinSource();
const fbSvc = { live: { sources: [fbSrc] } };
api.apply({ get: () => fbSvc, inject: (d, cb) => cb({ get: () => fbSvc }), effect: (fn) => fn() });
await new Promise((r) => setTimeout(r, 400));
const stillWorks = await fbSrc.candidates({ id: 'D' }, { query: '做个落地页', signal: {} });
ok(stillWorks.length > 0 && stillWorks[0].name === 'landing-page-design-hard-rules', '语义层不可用时中文检索照常');

/* ---------------------------- 测试 5c：自适应分组 ---------------------------- */

console.log('\n[5c] 小语料 / 碎组：分组应自适应');

function mount(list) {
  const srcObj = makeBuiltinSource(list);
  const svcObj = { live: { sources: [srcObj] } };
  api.apply({
    get: () => svcObj,
    inject: (d, cb) => cb({ get: () => svcObj }),
    effect: (fn) => fn(),
  });
  return srcObj;
}

// ① 3 个技能：不该出现任何标题
const tinySrc = mount(SKILLS.slice(0, 3));
await new Promise((r) => setTimeout(r, 400));
const tiny = await tinySrc.candidates({ id: 'T' }, { query: '', signal: {} });
ok(tiny.length === 3 && tiny.every((i) => i.section === undefined), '3 个技能时不分组');
ok(
  tiny.every((x, k) => k === 0 || String(tiny[k - 1].name) <= String(x.name)),
  '不分组时按名称升序（不留隐形分组）'
);
ok(api.diagnostics.grouping && api.diagnostics.grouping.grouped === false, '诊断里记录 grouped=false');

// ② 15 个技能，其中一个类只有 1 条：碎组并入「· 其他」
const byCat = {};
for (const s of idx.skills.filter((x) => x.userInvocable)) {
  (byCat[s.category] || (byCat[s.category] = [])).push(s.name);
}
const mixedNames = [
  ...byCat['eng'].slice(0, 10),
  ...byCat['motion'].slice(0, 4),
  ...byCat['deck'].slice(0, 1),
];
const mixedList = SKILLS.filter((s) => mixedNames.includes(s.name));
const mixedSrc = mount(mixedList);
await new Promise((r) => setTimeout(r, 400));
const mixed = await mixedSrc.candidates({ id: 'M' }, { query: '', signal: {} });

const sections = [...new Set(mixed.map((i) => i.section))];
ok(sections.length === 3, `15 个技能分为 3 组（实际 ${sections.length}）`, sections.join(' | '));
ok(sections.some((s) => String(s).indexOf('· 其他') === 0), '只有 1 条的小类被并入「· 其他」', sections.join(' | '));
ok(
  mixed.filter((i) => String(i.section).indexOf('· 其他') === 0).length === 1,
  '「· 其他」里正好 1 条'
);
ok(
  api.diagnostics.grouping.groups === 3,
  '诊断里记录 groups=3',
  String(api.diagnostics.grouping.groups)
);

// ③ 全量 110：仍是 9 组
const fullSrc = mount(SKILLS);
await new Promise((r) => setTimeout(r, 400));
const full = await fullSrc.candidates({ id: 'F' }, { query: '', signal: {} });
const expectGroups = new Set(idx.skills.filter((s) => s.userInvocable).map((s) => s.category)).size;
ok(new Set(full.map((i) => i.section)).size === expectGroups, `全量时组数等于实际类别数（${expectGroups}）`);

/* ---------------------------- 测试 6：面包屑与分类筛选 ---------------------------- */

console.log('\n[6] 面包屑与分类筛选');

// 前面几个小节挂载过别的目录，先清掉自适应状态再断言计数
api.diagnostics.resetAdaptive();


const hdrSrc = makeBuiltinSource();
const hdrSvc = { live: { sources: [hdrSrc] } };
api.apply({ get: () => hdrSvc, inject: (d, cb) => cb({ get: () => hdrSvc }), effect: (fn) => fn() });
await new Promise((r) => setTimeout(r, 400));

// 期望值必须从 index 推导：写死 9/110 会在技能库变化时误报，
// 而真正该守的是「bundle 与数据一致」这件事。
const visible = idx.skills.filter((s) => s.userInvocable);
const expectCats = new Set(visible.map((s) => s.category));

const rootHeader = hdrSrc.header({}, { query: '', quoted: false, drilled: false });
ok(
  Array.isArray(rootHeader) && rootHeader.length === expectCats.size,
  `空查询发布 ${expectCats.size} 个分类芯片`,
  String(rootHeader && rootHeader.length)
);
ok(
  rootHeader.every((c) => /^.+ \d+$/.test(c.label) && /^cat:/.test(c.value)),
  '每个芯片都是「短名 + 数量」且带跳转值',
  rootHeader.map((c) => c.label).join(',')
);
const sum = rootHeader.reduce((a, c) => a + Number(c.label.split(' ').pop()), 0);
ok(sum === visible.length, `芯片数量之和等于可见技能数 ${visible.length}（实际 ${sum}）`);

// 产物一致性：bundle 里烤死的 TOTAL 必须等于索引可见数。
// 这条能挡住「手工热补丁改 bundle / 用旧 index 打包」这类静默漂移。
const totalInBundle = /var TOTAL = (\d+);/.exec(src);
ok(
  totalInBundle && Number(totalInBundle[1]) === visible.length,
  'bundle 的 TOTAL 与 index.json 可见数一致',
  totalInBundle ? `${totalInBundle[1]} vs ${visible.length}` : '未找到 TOTAL'
);

// 点芯片 → 改写输入框为「/短名」并让菜单继续开着
const drillOut = hdrSrc.onPick({
  candidate: { name: '设计 22', value: 'cat:design' },
  action: 'drill',
  session: {},
  position: 0,
  via: 'menu',
  span: {},
});
ok(
  drillOut && drillOut.text === '/设计' && drillOut.continue === true,
  '点分类芯片改写输入框为「/设计」并保持菜单打开',
  JSON.stringify(drillOut)
);
const backOut = hdrSrc.onPick({
  candidate: { name: '全部', value: 'root' },
  action: 'drill',
  session: {},
  position: 0,
  via: 'menu',
  span: {},
});
ok(backOut && backOut.text === '/', '点「全部」回到根视图', JSON.stringify(backOut));

const catHeader = hdrSrc.header({}, { query: '设计', quoted: false, drilled: false });
ok(
  Array.isArray(catHeader) && catHeader.length === 2 && catHeader[1].current === true,
  '筛选时面包屑变成「全部 › 分类」',
  JSON.stringify(catHeader)
);

const designNames = new Set(
  idx.skills.filter((s) => s.userInvocable && s.category === 'design').map((s) => s.name)
);
const filtered = await hdrSrc.candidates({ id: 'X' }, { query: '设计', signal: {} });
ok(filtered.length === designNames.size, `输入分类名只返回该类的 ${designNames.size} 个`, String(filtered.length));
ok(filtered.every((i) => designNames.has(i.name)), '筛选结果全部属于该分类');

const plain = await hdrSrc.candidates({ id: 'X' }, { query: 'gsap', signal: {} });
ok(plain.length > 0 && !plain.every((i) => designNames.has(i.name)), '普通查询不触发分类筛选');

/* ---------------------------- 测试 7：运行时自适应 ---------------------------- */

console.log('\n[7] 运行时自适应：新装技能当场归类');

api.diagnostics.resetAdaptive();


const extra = [
  { name: 'new-skill-resume-writer', description: '帮用户写简历的示例技能', modelInvocable: true },
  { name: 'zeta-alpha', description: 'zzz qqq', modelInvocable: true },
  { name: 'zeta-beta', description: 'zzz qqq', modelInvocable: true },
  { name: 'zeta-gamma', description: 'zzz qqq', modelInvocable: true },
  { name: 'lonely-unknown', description: 'zzz qqq', modelInvocable: true },
];

const adSrc = mount([...SKILLS, ...extra]);
await new Promise((r) => setTimeout(r, 400));
const adItems = await adSrc.candidates({ id: 'A' }, { query: '', signal: {} });
const secOf = new Map(adItems.map((i) => [i.name, i.section]));

ok(
  String(secOf.get('new-skill-resume-writer') || '').includes('求职'),
  '未知技能按规则自动归入「求职与职业」',
  String(secOf.get('new-skill-resume-writer'))
);

const zetaSections = new Set(['zeta-alpha', 'zeta-beta', 'zeta-gamma'].map((n) => secOf.get(n)));
ok(
  zetaSections.size === 1 && String([...zetaSections][0]).includes('zeta'),
  '同族 3 个未知技能自动长出一个新分类',
  [...zetaSections].join(' | ')
);

ok(
  String(secOf.get('lonely-unknown') || '').includes('未归类'),
  '落单的未知技能仍留在「未归类」',
  String(secOf.get('lonely-unknown'))
);

const adHeader = adSrc.header({}, { query: '', quoted: false, drilled: false });
const adSum = adHeader.reduce((a, c) => a + Number(String(c.label).split(' ').pop()), 0);
ok(adSum === SKILLS.length + extra.length, `面包屑总数随自适应更新为 ${SKILLS.length}+${extra.length}（实际 ${adSum}）`);
ok(
  adHeader.some((c) => String(c.label).includes('zeta')),
  '新分类出现在面包屑芯片里',
  adHeader.map((c) => c.label).join(',')
);

// 卸载回退：同一会话里目录缩回去，计数必须跟着降，不能等刷新
const backSrc = mount(SKILLS);
await new Promise((r) => setTimeout(r, 400));
const backItems = await backSrc.candidates({ id: 'A' }, { query: '', signal: {} });
const backHeader = backSrc.header({}, { query: '', quoted: false, drilled: false });
const backSum = backHeader.reduce((a, c) => a + Number(String(c.label).split(' ').pop()), 0);
ok(backSum === SKILLS.length, `技能被删掉后总数回落到 ${SKILLS.length}（实际 ${backSum}）`);
ok(
  !backHeader.some((c) => String(c.label).includes('zeta')),
  '临时分类随技能消失一起撤掉',
  backHeader.map((c) => c.label).join(',')
);
ok(
  !backItems.some((i) => String(i.name).startsWith('zeta-')),
  '被删的技能不再出现在菜单里'
);

/* ---------------------------- 测试 8：绕过会话级缓存 ---------------------------- */

console.log('\n[8] 会话级缓存绕过（内置源只取一次目录）');

// 内置 "/" 源把目录缓存在 Map<sessionId> 里，一个会话只取一次。
// 这里模拟：源返回旧目录，但 RPC 能拿到新目录 —— 菜单必须显示新的。
const staleList = [{ name: 'stale-old-skill', description: '旧目录里的技能' }];
const freshSkills = [
  { name: 'brand-new-skill', description: '写简历找工作' },
  { name: 'another-new-skill', description: '做落地页' },
];

const staleSrc = {
  trigger: '/',
  name: 'skill',
  order: 2,
  async candidates() {
    return staleList;
  },
  onPick({ candidate }) {
    return { text: `/${candidate.name} ` };
  },
};
const fakeSvc = { live: { sources: [staleSrc] } };
const fakeRemote = { skills: { list: async () => ({ ok: true, value: { skills: freshSkills } }) } };
const fakeSessions = {
  binding: () => ({}),
  using: async (id, opts, fn) =>
    fn({ binding: { session: { getSnapshot: () => ({ openState: 'open' }) } } }),
};
const cacheCtx = {
  get: (n) =>
    n === 'inputTriggers'
      ? fakeSvc
      : n === 'remote'
        ? fakeRemote
        : n === 'sessions'
          ? fakeSessions
          : undefined,
  inject: (deps, cb) => cb(cacheCtx),
  effect: (fn) => fn(),
};

api.diagnostics.resetAdaptive();
api.apply(cacheCtx);
await new Promise((r) => setTimeout(r, 300));

const freshItems = await staleSrc.candidates({ sessionId: 'CACHE-TEST' }, { query: '', signal: {} });
const freshNames = freshItems.map((i) => i.name);
ok(freshNames.includes('brand-new-skill'), '菜单拿到的是新鲜目录（绕开会话缓存）', freshNames.join(','));
ok(!freshNames.includes('stale-old-skill'), '不再回落到旧目录');
ok(Number(api.diagnostics.freshFetches) >= 1, '走了 freshness 通道', String(api.diagnostics.freshFetches));

/* ---------------------------- 测试 9：目录即真相 ---------------------------- */

console.log('\n[9] 删除 / 空目录 / 计数推导 / 跨轮成族');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mountWithFresh(staleCatalog, freshSkills) {
  const stale = makeBuiltinSource(staleCatalog);
  const svc = { live: { sources: [stale] } };
  const remote = { skills: { list: async () => ({ ok: true, value: { skills: freshSkills } }) } };
  const sessions = {
    binding: () => ({}),
    using: async (id, o, fn) =>
      fn({ binding: { session: { getSnapshot: () => ({ openState: 'open' }) } } }),
  };
  const ctx = {
    get: (n) =>
      n === 'inputTriggers' ? svc : n === 'remote' ? remote : n === 'sessions' ? sessions : undefined,
    inject: (deps, cb) => {
      cb(ctx);
    },
    effect: (fn) => fn(),
  };
  api.apply(ctx);
  return stale;
}

// 9.1 空目录：不能回退到旧缓存
const sEmpty = mountWithFresh([{ name: 'old-a', description: '旧' }], []);
await sleep(250);
const rEmpty = await sEmpty.candidates({ sessionId: 'D-EMPTY' }, { query: '', signal: {} });
ok(rEmpty.length === 0, '空目录返回空，不回退旧缓存', String(rEmpty.length));

// 9.2 删除后旧模糊结果不得补回
const sGhost = mountWithFresh(
  [
    { name: 'ghost-removed', description: '已删除的旧技能' },
    { name: 'kept-skill', description: '还在的技能' },
  ],
  [{ name: 'kept-skill', description: '还在的技能' }]
);
const rGhost = await sGhost.candidates({ sessionId: 'D-GHOST' }, { query: 'ghost', signal: {} });
ok(
  !rGhost.some((i) => i.name === 'ghost-removed'),
  '已删技能不会被内置模糊结果加回来',
  rGhost.map((i) => i.name).join(',') || '(空)'
);

// 9.3 计数由当前目录推导
const sCount = mountWithFresh(
  [],
  [
    { name: 'count-one', description: '第一条' },
    { name: 'count-two', description: '第二条' },
  ]
);
await sCount.candidates({ sessionId: 'D-COUNT' }, { query: '', signal: {} });
const hCount = sCount.header({ sessionId: 'D-COUNT' }, { query: '', quoted: false, drilled: false });
const totalCount = (hCount || []).reduce((a, c) => a + Number(String(c.label).split(' ').pop()), 0);
ok(totalCount === 2, '合计等于当前目录条数', String(totalCount));

// 9.4 同族分三次各装一个 → 第三次应成组
const zeta1 = [{ name: 'zeta-one', description: '甲' }];
const zeta2 = [...zeta1, { name: 'zeta-two', description: '乙' }];
const zeta3 = [...zeta2, { name: 'zeta-three', description: '丙' }];

await mountWithFresh([], zeta1).candidates({ sessionId: 'f1' }, { query: '', signal: {} });
await mountWithFresh(zeta1, zeta2).candidates({ sessionId: 'f2' }, { query: '', signal: {} });
const sZeta = mountWithFresh(zeta2, zeta3);
await sZeta.candidates({ sessionId: 'f3' }, { query: '', signal: {} });
const hZeta = sZeta.header({ sessionId: 'f3' }, { query: '', quoted: false, drilled: false });
const zetaChip = (hZeta || []).find((c) => String(c.label).includes('zeta'));
ok(!!zetaChip, '跨轮累积同族技能也会成组', zetaChip ? zetaChip.label : '没有 zeta 分组');

/* ---------------------------- 测试 10：复测报告第二轮 ---------------------------- */

console.log('\n[10] 子代理契约 / 空目录归零 / 同长度改写 / 用户专用回退');

// 10.1 subagent 分支必须返回 thenable（宿主直接 .then()）
{
  const src10 = makeBuiltinSource([{ name: 'sub-probe', description: 'x' }]);
  const svc10 = { live: { sources: [src10] } };
  const sess10 = {
    binding: () => ({}),
    using: async (id, o, fn) =>
      fn({ binding: { session: { getSnapshot: () => ({ openState: 'open' }) } } }),
    subagentAddress: () => ({ agent: 'child' }),
  };
  const ctx10 = {
    get: (n) => (n === 'inputTriggers' ? svc10 : n === 'sessions' ? sess10 : undefined),
    inject: (deps, cb) => cb(ctx10),
    effect: (fn) => fn(),
  };
  api.apply(ctx10);
  await sleep(250);
  const r10 = src10.candidates({ sessionId: 'SUB-1' }, { query: '', signal: {} });
  ok(typeof r10.then === 'function', 'subagent 分支返回 Promise（宿主 .then 可用）', typeof r10);
  const v10 = await r10;
  ok(Array.isArray(v10) && v10.length === 0, 'subagent 会话返回空候选', String(v10 && v10.length));
}

// 10.2 空目录：候选为空，计数与索引同步归零
{
  const s10 = mountWithFresh([{ name: 'gone-a', description: '旧' }], []);
  await sleep(200);
  await s10.candidates({ sessionId: 'EMPTY-2' }, { query: '', signal: {} });
  const h10 = s10.header({ sessionId: 'EMPTY-2' }, { query: '', quoted: false, drilled: false });
  const total10 = (h10 || []).reduce((a, c) => a + Number(String(c.label).split(' ').pop()), 0);
  ok(total10 === 0, '空目录后合计归零', String(total10));
  const st10 = api.diagnostics.semanticStatus();
  ok(st10.indexed === 0, '空目录后索引条数归零', String(st10.indexed));
}

// 10.3 描述同长度改写也要刷新指纹
{
  const a10 = mountWithFresh([], [{ name: 'zz-editable', description: 'alpha' }]);
  await a10.candidates({ sessionId: 'FP-1' }, { query: '', signal: {} });
  const fp1 = api.diagnostics.semanticStatus().fp;

  const b10 = mountWithFresh([], [{ name: 'zz-editable', description: 'bravo' }]);
  await b10.candidates({ sessionId: 'FP-2' }, { query: '', signal: {} });
  const fp2 = api.diagnostics.semanticStatus().fp;
  ok(fp1 !== fp2, '同长度改写（alpha→bravo）也换指纹', `${fp1} vs ${fp2}`);
}

// 10.4 回退路径保留「用户专用」提示
{
  const stale10 = {
    trigger: '/',
    name: 'skill',
    order: 2,
    async candidates() {
      return [{ name: 'user-only-probe', description: '用户专用 · 当前最新描述' }];
    },
    onPick: () => ({ text: '/' }),
  };
  const svc10b = { live: { sources: [stale10] } };
  const remote10 = { skills: { list: async () => ({ ok: false, error: { code: 'x' } }) } };
  const ctx10b = {
    get: (n) => (n === 'inputTriggers' ? svc10b : n === 'remote' ? remote10 : undefined),
    inject: (deps, cb) => cb(ctx10b),
    effect: (fn) => fn(),
  };
  api.apply(ctx10b);
  await sleep(250);
  const r10b = await stale10.candidates({ sessionId: 'UO-1' }, { query: '', signal: {} });
  const hit = r10b.find((i) => i.name === 'user-only-probe');
  ok(
    hit && String(hit.description).indexOf('用户专用') === 0,
    '回退路径不覆盖「用户专用」前缀',
    hit ? String(hit.description).slice(0, 24) : '未找到'
  );
}

/* ---------------------------- 测试 11：语义索引生命周期 ---------------------------- */

console.log('\n[11] 旧任务的初始化失败不得改写新索引状态');

// 复刻报告 test-lifecycle.mjs 第一项：
//   旧任务 pipeline 初始化 pending → 目录切换、新任务就绪 → 旧任务才拒绝
{
  const rejecters = [];
  api.diagnostics.setSemHooks({
    importLib: () =>
      new Promise((resolve, reject) => {
        rejecters.push(reject);
      }),
  });

  const sA = mountWithFresh([], [{ name: 'old-initializing', description: '旧' }]);
  await sA.candidates({ sessionId: 'SEM-1' }, { query: '', signal: {} });
  await sleep(60);

  // 显式更换 provider：目录刷新本身现在复用同一个初始化任务。
  api.diagnostics.setSemHooks({ importLib: () => new Promise((resolve, reject) => rejecters.push(reject)) });
  // 目录换成 B（旧 provider 的任务代次过期）
  const sB = mountWithFresh([], [{ name: 'new-current', description: '新' }]);
  await sB.candidates({ sessionId: 'SEM-2' }, { query: '', signal: {} });
  await sleep(60);

  const stBefore = api.diagnostics.semanticStatus();
  const genBefore = stBefore.gen;

  // 让最早的、已过期的初始化失败
  ok(rejecters.length >= 2, '两个不同 provider 的初始化均已启动');
  if (rejecters.length >= 2) rejecters[0](new Error('obsolete pipeline initialization failed'));
  await sleep(80);

  const stAfter = api.diagnostics.semanticStatus();
  ok(
    stAfter.status !== 'unavailable',
    '过期任务的初始化失败不把状态改成 unavailable',
    `${stBefore.status} → ${stAfter.status}`
  );
  ok(
    stAfter.error !== 'obsolete pipeline initialization failed',
    '过期任务的错误不写入 error',
    String(stAfter.error)
  );
  ok(stAfter.gen === genBefore, '失败不改变任务代次', `${genBefore} vs ${stAfter.gen}`);

  for (let i = 1; i < rejecters.length; i++) rejecters[i](new Error('cleanup'));
  await sleep(60);
  api.diagnostics.setSemHooks(null);
}

/* ---------------------- 测试 12：发行产物的真实建索引路径 ---------------------- */

console.log('\n[12] 空缓存 + 正常模型输出 → 索引必须真正建起来');

// 语法检查查不出「声明被并进注释」：那仍然是合法 JS。
// 这里两条防线：产物行级 lint + 真跑一遍建索引。
{
  const swallowed = src
    .split(/\r?\n/)
    .filter((l) => /^\s*\/\/.*\t{2,}(var|let|const|function|return|if|for|while)\b/.test(l));
  ok(swallowed.length === 0, '发行 bundle 没有「注释吞掉声明」的行', swallowed[0] || '');

  // The runtime moved into its own source file. The real indexing assertions
  // below catch a missing accumulator without depending on a comment's wording.
}

{
  // 清空向量缓存，模拟全新机器
  try {
    store.delete('dsh.skillcat.vec.v1');
  } catch (e) {}

  let vectorized = 0;
  api.diagnostics.setSemHooks({
    importLib: async () => ({ env: {} }),
    makePipe: async () => async () => {
      vectorized++;
      return { data: [1, 0, 0, 0] };
    },
  });

  const sSem = mountWithFresh([], [
    { name: 'idx-alpha', description: '第一条' },
    { name: 'idx-beta', description: '第二条' },
  ]);
  await sSem.candidates({ sessionId: 'IDX-1' }, { query: '', signal: {} });
  await sleep(150);

  const st = api.diagnostics.semanticStatus();
  ok(st.status === 'ready', '空缓存下索引达到 ready', `${st.status} / ${st.error || ''}`);
  ok(st.indexed === 2, '索引条数等于目录条数', String(st.indexed));
  ok(JSON.stringify(st.names.slice().sort()) === JSON.stringify(['idx-alpha', 'idx-beta']), '索引包含正确的技能，不只是条数相等');
  ok(st.error === null, '成功时 error 为空', String(st.error));
  ok(vectorized >= 2, '模型确实被调用过', String(vectorized));

  let cached = null;
  try {
    cached = JSON.parse(store.get('dsh.skillcat.vec.v1') || 'null');
  } catch (e) {}
  ok(cached && cached.fp === st.fp, '持久缓存带上当前指纹', cached ? String(cached.fp) : '无缓存');
  ok(
    cached && Array.isArray(cached.v) && cached.v.length === 2,
    '持久缓存写入 2 条向量',
    cached && cached.v ? String(cached.v.length) : '无'
  );

  api.diagnostics.setSemHooks(null);
}

console.log('\n[6] 用 asar 渲染器判据模拟菜单输出\n');

// 重新包装一次，取分组后的数据
const renderSrc = makeBuiltinSource();
const renderSvc = { live: { sources: [renderSrc] } };
api.apply({ get: () => renderSvc, inject: (d, cb) => cb({ get: () => renderSrc }), effect: (fn) => fn() });
await new Promise((r) => setTimeout(r, 400));
const finalItems = await renderSrc.candidates({ sessionId: 's1' }, { query: '', signal: { aborted: false } });

// 渲染器规则：
//   group.items.some(i => i.section !== undefined) → 隐藏源级标题
//   item.section !== undefined && item.section !== items[i-1]?.section → 插入 sectionTitle
const hasAnySection = finalItems.some((i) => i.section !== undefined);
console.log(`  源级标题「skill」显示：${hasAnySection ? '否（因存在 section，被自动隐藏）' : '是'}`);

let shown = 0;
let prev = undefined;
for (let i = 0; i < finalItems.length; i++) {
  const it = finalItems[i];
  if (it.section !== undefined && it.section !== prev) {
    console.log(`\n  ── ${it.section} ──`);
  }
  prev = it.section;
  if (shown < 200) console.log(`     ${it.name}`);
  shown++;
}

/* ---------------------------- 汇总 ---------------------------- */

console.log('\n' + '─'.repeat(60));
console.log(`断言：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
console.log('客户端插件行为验证通过。');
