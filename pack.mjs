/**
 * pack.mjs — 把分类索引打包成 DSH 客户端插件
 *
 * 产物：~/.dsh/local-plugins/dsh-skill-categories/
 *   package.json         dsh.bundle.patch + dsh.client
 *   cordis.patch.yml     装配层（insert 一行 entry）
 *   lib/index.js         宿主半边（仅诊断标记）
 *   lib/client.js        客户端半边：本地排序 + 9 类分组 + 埋点
 *
 * 三条硬约束（都是踩坑换来的）：
 *   1. manifest 必须有 dsh.bundle.patch，否则被当成普通依赖静默跳过
 *   2. factory 必须自己声明 module / exports（loader 只传 require）
 *   3. 初始化全程 try/catch，异常降级空插件，绝不能让 web boot 失败
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pluginDir } from './paths.mjs';
import { TAXONOMY, EN_RULES, MIN_SCORE, NAME_BOOST, STRONG_NAME_BONUS } from './taxonomy.mjs';
import { FACET_TO_DISPLAY } from './display.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));

const idx = readJson(join(HERE, 'index.json'));
const aliases = readJson(join(HERE, 'aliases.json'));
const curated = readJson(join(HERE, 'curated.json'));

/** 排序内核：唯一实现在 rank-core.mjs，这里剥掉 export 内联进浏览器 */
const rankSrc = readFileSync(join(HERE, 'rank-core.mjs'), 'utf8')
  .replace(/^export\s+/gm, '')
  .replace(/^\s*\/\*\*[\s\S]*?\*\//m, '') // 去掉文件头注释，避免嵌套进模板
  .trim();

// 输出位置统一从 paths.mjs 取，这样 DSH_HOME 覆盖对生成阶段也生效
const runtimeSource = (name) => readFileSync(join(HERE, name), 'utf8');
const OUT = pluginDir();
mkdirSync(join(OUT, 'lib'), { recursive: true });

/* ---------------------------- 数据 ---------------------------- */

/** 展示类：id → {order,label}，label 即菜单分组标题 */
const cats = {};
for (const t of idx.taxonomy) cats[t.id] = { order: t.order, label: `${t.glyph} ${t.label}` };
cats.misc = { order: 999, label: '· 未归类' };

/** 技能名 → 展示类 id */
const map = {};
/** 技能名 → 一行短描述 */
const short = {};
/** 技能名 → 安全级 */
const safety = {};
for (const s of idx.skills) {
  map[s.name] = s.category in cats ? s.category : 'misc';
  short[s.name] = s.shortDesc || s.desc || '';
  safety[s.name] = s.safety;
}

const stats = { skills: Object.keys(map).length, groups: idx.taxonomy.length };

/**
 * 只有「规则算不出来」的分类才允许钉死：人工覆盖（source=manual）与名字族（dyn-*）。
 * 其余技能一律不烘结果 —— 客户端每次都拿当前目录现算，
 * 这样装/删技能立刻改变分类和计数，不需要重建、不需要重启。
 */
const pins = {};
for (const s of idx.skills) {
  const manual = s.source === 'manual';
  const family = String(s.category || '').startsWith('dyn-');
  if (manual || family) pins[s.name] = s.category;
}

/** 分类的纯名字（去掉字形前缀），用于「输入分类名直接筛选」 */
const catName = {};
for (const t of idx.taxonomy) catName[t.id] = t.label;
catName.misc = '未归类';

/** 分类的短名（「设计与视觉」→「设计」），用于面包屑芯片，省宽度 */
const catShort = {};
for (const id of Object.keys(catName)) catShort[id] = String(catName[id]).split('与')[0];

/**
 * 计数口径（分类依据 v1，见 docs/CLASSIFICATION.md）：
 *   TOTAL = 目录里出现的**所有**技能，CATCOUNT = 每个展示类的条目数。
 *
 * 为什么不按 userInvocable 过滤：列表本身会把隐藏技能（只允许模型调用、
 * 不允许用户点的那几个）也渲染出来。若只统计可见的，就会出现
 * 「评审 19」但下面明明列了 21 行 —— 芯片数字和列表行数对不上。
 * 口径必须和渲染面一致，否则用户一旦数行数就会发现矛盾。
 */
const catCount = {};
for (const s of idx.skills) {
  const c = map[s.name];
  catCount[c] = (catCount[c] || 0) + 1;
}
/** 目录总数（与 CATCOUNT 各项之和恒等） */
const total = idx.skills.length;

/**
 * 规则表打进 bundle。
 *
 * 为什么：索引是构建时的快照，用户之后装的技能不在里面。只带「分类结果」的话，
 * 新技能只能落到 misc。把规则本身带进客户端，未知技能就能当场分类 ——
 * 装完立刻生效，不需要重跑构建。
 */
const ruleTable = TAXONOMY.map((c) => ({
  id: c.id,
  order: c.order,
  label: `${c.glyph} ${c.label}`,
  name: c.label,
  short: String(c.label).split('与')[0],
  strong: (c.strongName || []).map(String),
  // 必须并入 EN_RULES：scoreSkill 在构建期把两边合在一起算，
  // 运行时如果只带 c.rules，docx / pdf 这类英文描述的技能会全部掉进未归类。
  rules: [...c.rules, ...(EN_RULES[c.id] || [])].map((r) => [String(r.re), r.w]),
}));

/**
 * 本地分类（taxonomy.local.json）也要有运行时规则，
 * 否则用户自建的新类只能靠构建固化，新装同类技能仍然要靠下次 setup 才进去。
 */
let localTax = { categories: [] };
try {
  localTax = readJson(join(HERE, 'taxonomy.local.json'));
} catch {}

const builtinFacetIds = new Set(TAXONOMY.map((c) => c.id));
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

for (const t of idx.taxonomy) {
  if (builtinFacetIds.has(t.id)) continue;
  const def = (localTax.categories || []).find((c) => c && c.id === t.id) || {};
  const kws = (def.keywords || []).filter(Boolean);
  ruleTable.push({
    id: t.id,
    order: t.order,
    label: `${t.glyph} ${t.label}`,
    name: t.label,
    short: String(t.label).split('与')[0],
    strong: [],
    rules: kws.length ? [[`/(${kws.map(escapeRe).join('|')})/i`, 9]] : [],
  });
}

const ruleScore = { min: MIN_SCORE, boost: NAME_BOOST, strong: STRONG_NAME_BONUS };

/**
 * 细分面 → 展示类。
 *
 * 分类器输出的是 facet（office / style / tools …），菜单分组用的是 display（doc / design / review-tool）。
 * 两套 id 只有一部分同名（page / deck / motion / career / eng），
 * 漏掉这层映射的话，office / style / tools 这类会全部掉进「未归类」。
 */
const facetToDisplay = {};
for (const [facet, display] of FACET_TO_DISPLAY.entries()) facetToDisplay[facet] = display;

/* ------------------- 发货前自证：运行期规则必须复现索引 ------------------- */

const parseResrc = (src) => {
  const s = String(src);
  if (s.length > 2 && s.charAt(0) === '/') {
    const end = s.lastIndexOf('/');
    return new RegExp(s.slice(1, end), s.slice(end + 1));
  }
  return new RegExp(s);
};

const classifyWithRules = (name, desc) => {
  const hayName = String(name).replace(/-/g, ' ');
  const text = String(desc || '');
  let bestId = null;
  let bestScore = 0;
  for (const cat of ruleTable) {
    let score = 0;
    for (const src of cat.strong) if (parseResrc(src).test(name)) score += ruleScore.strong;
    for (const pat of cat.rules) {
      const re = parseResrc(pat[0]);
      if (re.test(text)) score += pat[1];
      if (re.test(hayName)) score += pat[1] * ruleScore.boost;
    }
    if (score > bestScore) {
      bestScore = score;
      bestId = cat.id;
    }
  }
  return bestScore >= ruleScore.min ? bestId : null;
};

const drift = [];
for (const s of idx.skills) {
  if (pins[s.name]) continue;
  const facet = classifyWithRules(s.name, s.desc || '');
  const want = facet ? facetToDisplay[facet] || facet : 'misc';
  if (want !== s.category) drift.push(`${s.name}: 索引=${s.category} 运行期=${want}`);
}
if (drift.length) {
  console.error(`✗ 运行期规则与索引不一致（${drift.length} 条）——装上以后数字会跳变：`);
  for (const d of drift.slice(0, 12)) console.error('   ' + d);
  console.error('   修法：调 taxonomy.mjs 规则，或把该技能登记成 pins（人工覆盖）。');
  process.exit(1);
}

/* ---------------------------- 宿主半边 ---------------------------- */

writeFileSync(
  join(OUT, 'lib', 'index.js'),
  `/**
 * dsh-skill-categories — 宿主半边
 *
 * 分类逻辑全在浏览器侧（lib/client.js）。宿主这里只做一件事：
 * 盯住技能目录，一有增删就让技能目录缓存失效 —— 这样装完技能
 * 关掉再按一次 "/" 就能看到，不必重启 DSH。
 *
 * 为什么还要自己盯：宿主自带的 watcher 默认开着，但关掉了 polling、
 * 或技能放在网络盘 / 被 chokidar 漏事件时就会 stale。多一层兜底成本极低。
 */

import { appendFileSync, watch, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const name = 'dsh-skill-categories';

/**
 * 必须声明依赖：Cordis 只有声明了 inject，apply 才会拿到已挂载的 skills 服务。
 * 之前没声明，ctx.skills 是 undefined，invalidateCache 全被 guard 静默跳过 ——
 * 日志里看着 "invalidate #1" 很成功，实际一次都没生效。
 */
export const inject = ['skills'];

const LOG = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'skill-categories-host.log');

function note(line) {
	try {
		appendFileSync(LOG, new Date().toISOString() + '  ' + line + String.fromCharCode(10));
	} catch {}
}

try {
	note('imported');
} catch {}

export function apply(ctx) {
	note('applied');

	// 取证用：把宿主真实目录的名单写进日志。
	// 客户端渲染的是「宿主给的目录」，我构建索引时读的是磁盘 —— 两者一旦不一致，
	// 界面数字就会和我算的不一样。没有这份名单，只能靠猜。
	// 启动时必写一次（一行）；后续只在手动放了标记文件时写，避免日志膨胀。
	const dumpMarker = join(process.env.TEMP || process.env.TMPDIR || '/tmp', 'dsh-skillcat-dump');
	const dumpCatalog = (force) => {
		if (!force) {
			try {
				if (!existsSync(dumpMarker)) return;
			} catch {
				return;
			}
		}
		try {
			const svc = ctx && ctx.skills;
			if (!svc || typeof svc.list !== 'function') {
				note('catalog skipped: no skills.list');
				return;
			}
			Promise.resolve(svc.list({})).then((list) => {
				const names = (Array.isArray(list) ? list : []).map((s) => s && s.name).filter(Boolean);
				note('catalog ' + names.length + ' :: ' + names.join(','));
			}).catch((e) => note('catalog error: ' + String((e && e.message) || e)));
		} catch (e) {
			note('catalog crash: ' + String((e && e.message) || e));
		}
	};

	dumpCatalog(true);

	try {
		// 技能可能有五个根（DSH 的 dsh-skill-filesystem 就是按这个顺序找的）：
		// 项目 .dsh/skills、项目 .agents/skills、$DSH_HOME/skills、~/.agents/skills。
		// 以前只盯最后一个，把技能放进项目里就不会触发刷新。
		const cand = [
			join(process.cwd(), '.dsh', 'skills'),
			join(process.cwd(), '.agents', 'skills'),
			join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'skills'),
			process.env.AGENTS_SKILLS_DIR || join(process.env.AGENTS_HOME || join(homedir(), '.agents'), 'skills'),
		];
		const roots = [];
		for (const r of cand) {
			if (!r) continue;
			if (roots.indexOf(r) >= 0) continue;
			if (!existsSync(r)) continue;
			roots.push(r);
		}
		if (!roots.length) {
			note('watch skipped: no skill root found');
			return;
		}

		let timer = null;
		let hits = 0;

        // Only catalog metadata can invalidate a skill listing. Ignore recursive
        // dependency/build output events and backup skill directories.
        const relevant = (event, file) => {
            if (!file) return true;
            const parts = String(file).split(String.fromCharCode(92)).join('/').split('/');
            if (parts.some((p) => p.startsWith('.') || p === 'node_modules' || /[.](bak|backup)[-. ]/i.test(p))) return false;
            if (parts.length === 1) return event === 'rename';
            return parts.length === 2 && parts[1].toLowerCase() === 'skill.md';
        };
		const bump = (event, file) => {
            if (!relevant(event, file)) return;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = null;
				hits++;
				// 注意：这个变量必须在 try 之前声明 —— 之前漏了声明，
				// 事件一触发就 ReferenceError，直接把宿主进程打崩。
				const hasService = !!(ctx && ctx.skills && typeof ctx.skills.invalidateCache === 'function');
				// 日志必须反映「真的成功」，不能只说明「方法存在」。
				// 评测注入过 invalidateCache 抛错的情况，旧写法仍打印 service-ok。
				let state = hasService ? 'ok' : 'SERVICE-MISSING';
				if (hasService) {
					try {
						ctx.skills.invalidateCache();
					} catch (e) {
						state = 'FAILED:' + String((e && e.message) || e);
					}
				}
				try {
					if (ctx && ctx.skills && typeof ctx.skills.notifyChange === 'function') {
						ctx.skills.notifyChange();
					}
				} catch {}
				note(
					'invalidate #' + hits + '  ' + state +
						'  ' + String(event || '') + '  ' + String(file || '')
				);
			}, 250);
			if (timer.unref) timer.unref();
		};

		const watchers = [];
		for (const root of roots) {
			let watcher;
			try {
				watcher = watch(root, { recursive: true }, bump);
			} catch (e) {
				note('watch failed: ' + root + ' ' + String((e && e.message) || e));
				continue;
			}
			// fs.watch 的错误是异步事件，外层 try/catch 接不到；
			// 不注册的话会成为未捕获异常，把宿主进程带走。
			if (watcher && typeof watcher.on === 'function') {
				watcher.on('error', (e) => {
					note('watch error: ' + root + ' ' + String((e && e.message) || e));
				});
				watcher.on('close', () => {
					note('watch closed: ' + root);
				});
			}
			watchers.push(watcher);
			note('watching ' + root);
		}

		// Cordis effect：插件卸载时关掉所有 watcher
		if (ctx && typeof ctx.effect === 'function') {
			try {
				ctx.effect(() => () => {
					for (const w of watchers) {
						try {
							w.close();
						} catch {}
					}
					if (timer) clearTimeout(timer);
				});
			} catch {}
		}
	} catch (e) {
		note('watch failed: ' + (e && e.message));
	}
}
`,
  'utf8'
);

/* ---------------------------- 客户端半边 ---------------------------- */

/* 构建标识：清单版本 + 构建时刻，避免所有文件都叫同一个版本号 */
// BOM 会让 JSON.parse 直接抛 "Unexpected token"，而 Windows 上的编辑器
// 很容易给 package.json 加 BOM（PowerShell 的 Set-Content -Encoding utf8 就会）。
// 这里先剥掉，构建不因为一个不可见字符整体失败。
const readText = (p) => readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
const PKG_VERSION = JSON.parse(readText(join(HERE, 'package.json'))).version;
const BUILD_ID = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const VERSION = PKG_VERSION + '+' + BUILD_ID;

const clientSrc = `/**
 * dsh-skill-categories — 客户端半边
 *
 * 做三件事：
 *   1. 接管 / 菜单的技能排序：先取全量，再按「人工词 > 泛词 > 名称 > 描述」本地重排
 *      （内置 rankByName 只匹配技能名，实测中文意图命中为 0）
 *   2. 空查询时按 9 个展示类分组（不做频率重排，顺序永久固定）
 *   3. 本地埋点，供后续用真实数据决定要不要截断/调权重
 *
 * 生成时间 ${new Date().toISOString()} · ${stats.skills} 个技能 / ${stats.groups} 个展示类
 */
window.__ModuleLoader__.load({
	id: 'dsh-skill-categories',
	factory: function (require) {
		'use strict';

		// loader 只传 require，不提供 module / exports —— 必须自己声明
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		// 版本落盘：桌面端只在启动时应用补丁，靠这个键可以确认正在跑的是哪一版
		try {
			window.localStorage.setItem('dsh.skillcat.version', '3.4.0');
		} catch (e) {}

		// 任何异常都降级为空插件，绝不能让 web boot 失败
		try {

		var CATS = ${JSON.stringify(cats)};
		var CATNAME = ${JSON.stringify(catName)};
		var CATSHORT = ${JSON.stringify(catShort)};
		var CATCOUNT = ${JSON.stringify(catCount)};
		var TOTAL = ${JSON.stringify(total)};
		var MAP = ${JSON.stringify(map)};
		var PINS = ${JSON.stringify(pins)};
		var SHORT = ${JSON.stringify(short)};
		var SAFETY = ${JSON.stringify(safety)};
		var ALIASES = ${JSON.stringify(aliases)};
		var CURATED = ${JSON.stringify(curated)};
		var RULES = ${JSON.stringify(ruleTable)};
		var RSCORE = ${JSON.stringify(ruleScore)};
		var F2D = ${JSON.stringify(facetToDisplay)};

		/* ---------------- 排序内核（与 rank-core.mjs 同源） ---------------- */
${rankSrc
  .split('\n')
  .map((l) => (l.trim() ? '\t\t' + l : l))
  .join('\n')}

		/* ---------------- 运行时自适应分类 ---------------- */

		/**
		 * 索引是构建时的快照；用户之后装的技能不在 MAP 里。
		 * 这里把规则表带进客户端，让未知技能当场分类，分不出的按名字族聚成临时分类。
		 * 目标：装完新技能不用重跑构建，菜单自己长出新分组。
		 */
		var RE_CACHE = {};

		function parseRe(src) {
			if (Object.prototype.hasOwnProperty.call(RE_CACHE, src)) return RE_CACHE[src];
			// 不用正则解析 "/pat/flags"：这段在模板字符串里，反斜杠会被吞掉。
			var first = String(src).indexOf('/');
			var last = String(src).lastIndexOf('/');
			if (first !== 0 || last <= 0) {
				RE_CACHE[src] = null;
				return null;
			}
			var body = String(src).slice(1, last);
			var flags = String(src).slice(last + 1);
			try {
				var r = new RegExp(body, flags);
				RE_CACHE[src] = r;
				return r;
			} catch (e) {
				RE_CACHE[src] = null;
				return null;
			}
		}

		/** 与 taxonomy.mjs 的 scoreSkill 同构（去掉仲裁细节，只取最高分类） */
		function classifyRuntime(name, desc) {
			var hayName = String(name).replace(/-/g, ' ');
			var text = String(desc || '');
			var bestId = null;
			var bestScore = 0;
			for (var i = 0; i < RULES.length; i++) {
				var cat = RULES[i];
				var score = 0;
				for (var j = 0; j < cat.strong.length; j++) {
					var sr = parseRe(cat.strong[j]);
					if (sr && sr.test(name)) score += RSCORE.strong;
				}
				for (var k = 0; k < cat.rules.length; k++) {
					var pat = cat.rules[k];
					var rr = parseRe(pat[0]);
					if (!rr) continue;
					if (rr.test(text)) score += pat[1];
					if (rr.test(hayName)) score += pat[1] * RSCORE.boost;
				}
				if (score > bestScore) {
					bestScore = score;
					bestId = cat.id;
				}
			}
			return bestScore >= RSCORE.min ? bestId : null;
		}

		/** 同名前缀达到这个数就当成一个生态，整体成组（不再逐条分类） */
		var FAMILY_MIN = 5;

		/** 本轮名字族征用到的技能（调试/图例用） */
		var DYN = {};
		var COVERED = {};

		/** 单个技能 → 展示类；规则算不出来时返回 null（落未归类） */
		function catOfName(name, desc) {
			var pin = PINS[name];
			if (pin) return CATS[pin] ? pin : null;
			var facet = classifyRuntime(name, desc || '');
			if (!facet) return null;
			var cat = F2D[facet] || facet;
			return CATS[cat] ? cat : null;
		}

		/** 名字族临时分类（dyn-*）没有成员了就删掉，免得芯片残留 */
		function pruneDyn(counts) {
			for (var id in CATS) {
				if (!Object.prototype.hasOwnProperty.call(CATS, id)) continue;
				if (id.indexOf('dyn-') !== 0) continue;
				if (counts[id]) continue;
				delete CATS[id];
				delete CATNAME[id];
				delete CATSHORT[id];
				delete CATCOUNT[id];
			}
		}

		/**
		 * 用**当前目录**重建整套账：MAP / CATCOUNT / TOTAL。
		 *
		 * 这是唯一的真源：不再「构建期烘一批 + 运行时补差额」。
		 * 旧增量逻辑会留下历史包袱——烘焙进来的删不掉、运行时补进来的
		 * 又只在 AUTO 里记过名，于是屏幕上出现过 156/设计 25 这种
		 * 既不是索引、也不是目录的数字。现在每次目录变化都从零算一遍，
		 * 装/删/改名立刻正确，不需要重建 bundle、不需要重启。
		 */
		function syncCatalog(all, session) {
			// 空目录同样要算：计数归零、面包屑清空
			if (!all) return;

			var i;
			var nextMap = {};
			var counts = {};
			for (var id in CATS) {
				if (Object.prototype.hasOwnProperty.call(CATS, id)) counts[id] = 0;
			}
			if (!CATS.misc) CATS.misc = { order: 999, label: '· 未归类' };
			if (!CATNAME.misc) CATNAME.misc = '未归类';
			if (!CATSHORT.misc) CATSHORT.misc = '未归';
			counts.misc = 0;

			// ── 1. 逐条判定（索引外的技能走同一套规则）──
			var pool = [];
			var total = 0;
			for (i = 0; i < all.length; i++) {
				var it = all[i];
				if (!it || typeof it.name !== 'string') continue;
				total++;
				var cat = catOfName(it.name, it.description || it.desc || '');
				if (cat) {
					nextMap[it.name] = cat;
					counts[cat] = (counts[cat] || 0) + 1;
				} else {
					nextMap[it.name] = 'misc';
					counts.misc++;
					pool.push(it);
				}
			}

			// ── 2. 名字族：未归类的按前缀聚，够数就整族成一个临时类 ──
			// 未归类池里的同前缀成员：3 个就该成族（用户一次装 3 个同类是最常见的情形）。
			var famMin = 3;
			var fam = {};
			for (i = 0; i < pool.length; i++) {
				var pre = String(pool[i].name).split('-')[0] || '';
				if (pre.length < 3) continue;
				(fam[pre] = fam[pre] || []).push(pool[i]);
			}
			DYN = {};
			for (var key in fam) {
				if (!Object.prototype.hasOwnProperty.call(fam, key)) continue;
				var members = fam[key];
				if (members.length < famMin) continue;
				var fid = 'dyn-' + String(key).toLowerCase().replace(/[^a-z0-9]+/g, '');
				if (!CATS[fid]) {
					CATS[fid] = { order: 900 + Object.keys(CATS).length, label: '✦ ' + key };
					CATNAME[fid] = key;
					CATSHORT[fid] = key;
					diag.autoGroups = (diag.autoGroups || 0) + 1;
				}
				counts[fid] = 0;
				for (i = 0; i < members.length; i++) {
					nextMap[members[i].name] = fid;
					DYN[members[i].name] = fid;
					counts[fid]++;
					counts.misc--;
				}
			}

			// ── 3. 落账 ──
			pruneDyn(counts);
			MAP = nextMap;
			for (var c2 in counts) {
				if (Object.prototype.hasOwnProperty.call(counts, c2)) CATCOUNT[c2] = counts[c2];
			}
			TOTAL = total;
			COVERED = {};
			for (var nm in MAP) {
				if (Object.prototype.hasOwnProperty.call(MAP, nm)) COVERED[nm] = 1;
			}
			diag.recounted = (diag.recounted || 0) + 1;
			diag.classified = total;
			diag.pinned = Object.keys(PINS).length;
			// 数字变了就地修已经发给宿主的面包屑，避免「芯片 23 / 分组 24」
			syncCrumbs(session);
			// 把这次真正用的账写进 localStorage，供外部取证（不影响渲染）
			noteDiag(all);

			// 索引跟随目录：内容一变就作废，下次浏览时重建
			var fp = catalogFingerprint(all);
			if (SEM.fp !== fp) {
				if (SEM.fp !== '') {
					diag.semInvalidated = (diag.semInvalidated || 0) + 1;
					// 代次 +1：正在跑的旧索引任务完成后不许提交结果
					SEM.gen++;
					if (SEM.status === 'ready' || SEM.status === 'loading') {
						SEM.status = 'idle';
						SEM.vectors = null;
					}
				}
				SEM.fp = fp;
			}
		}

		/**
		 * 复位自适应状态（调试 / 测试用）。
		 * 真实会话里只有一份目录，用不到；测试会反复挂载不同目录，需要清场。
		 */
		var INIT_STATE = {
			MAP: JSON.parse(JSON.stringify(MAP)),
			CATS: JSON.parse(JSON.stringify(CATS)),
			CATNAME: JSON.parse(JSON.stringify(CATNAME)),
			CATSHORT: JSON.parse(JSON.stringify(CATSHORT)),
			CATCOUNT: JSON.parse(JSON.stringify(CATCOUNT)),
			TOTAL: TOTAL,
		};

		function resetAdaptive() {
			MAP = JSON.parse(JSON.stringify(INIT_STATE.MAP));
			CATS = JSON.parse(JSON.stringify(INIT_STATE.CATS));
			CATNAME = JSON.parse(JSON.stringify(INIT_STATE.CATNAME));
			CATSHORT = JSON.parse(JSON.stringify(INIT_STATE.CATSHORT));
			CATCOUNT = JSON.parse(JSON.stringify(INIT_STATE.CATCOUNT));
			TOTAL = INIT_STATE.TOTAL;
			COVERED = {};
			DYN = {};
			diag.autoClassified = 0;
			diag.autoGroups = 0;
		}

		/* ---------------- 埋点（内存缓冲 + 定时落盘） ---------------- */

		// 评测反馈：每次查询都同步读写整个 2000 条数组会拖慢输入。
		// 改为内存累积 + 1.2s 节流落盘；导出前强制 flush。
		var TELEMETRY_KEY = 'dsh.skillcat.telemetry';
		var TELEMETRY_MAX = 2000;
		var FLUSH_DELAY_MS = 1200;
		var diag = { patched: false, version: '3.4.0', events: 0, degraded: null };

		var buf = null;
		var flushTimer = null;

		function loadEvents() {
			if (buf) return buf;
			try {
				var raw = window.localStorage.getItem(TELEMETRY_KEY);
				buf = raw ? JSON.parse(raw) : [];
				if (!buf || typeof buf.length !== 'number') buf = [];
			} catch (e) {
				buf = [];
			}
			return buf;
		}

		function flush() {
			flushTimer = null;
			try {
				var arr = loadEvents();
				if (arr.length > TELEMETRY_MAX) {
					buf = arr = arr.slice(arr.length - TELEMETRY_MAX);
				}
				window.localStorage.setItem(TELEMETRY_KEY, JSON.stringify(arr));
				diag.events = arr.length;
			} catch (e) {
				// 配额满或隐私模式：静默放弃，不影响检索
			}
		}

		function log(event) {
			try {
				var arr = loadEvents();
				event.t = Date.now();
				arr.push(event);
				if (flushTimer === null && typeof setTimeout === 'function') {
					flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
				}
			} catch (e) {}
		}

		diag.export = function () {
			flush();
			return JSON.stringify(loadEvents(), null, 2);
		};
		diag.clear = function () {
			try {
				buf = [];
				window.localStorage.removeItem(TELEMETRY_KEY);
				diag.events = 0;
			} catch (e) {}
		};

		/** 语义层的可观测状态：idle / loading / ready / unavailable（含失败原因） */
		diag.resetAdaptive = resetAdaptive;
		diag.classifyRuntime = classifyRuntime;

		diag.semanticStatus = function () {
			return {
				status: SEM.status,
				error: SEM.error,
				indexed: SEM.vectors ? SEM.vectors.length : 0,
				model: SEM.model,
				fp: SEM.fp,
				gen: SEM.gen,
				names: SEM.vectors ? SEM.vectors.map(function (v) { return v.name; }) : []
			};
		};
		/** 手动预热（调试用）：任何时候都可以主动触发一次加载 */
		diag.setSemHooks = function (h) {
			SEM_HOOKS = h || null;
			// 注入钩子时复位索引状态，便于用可控时序复现生命周期场景
			if (h) {
				SEM.status = 'idle';
				SEM.error = null;
				SEM.vectors = null;
				SEM.gen++;
				dropPipeline();
				VECTOR_CACHE.clear();
				VECTOR_CACHE_LOADED = false;
			}
			return true;
		};
		diag.warmState = function () {
			return { kind: WARM_KIND, pending: !!WARM_HANDLE, started: diag.warmStarted || 0, scheduled: diag.warmScheduled || 0 };
		};
		diag.cancelWarm = function () {
			try {
				if (WARM_HANDLE) {
					if (WARM_KIND === 'idle' && typeof cancelIdleCallback === 'function') cancelIdleCallback(WARM_HANDLE);
					else clearTimeout(WARM_HANDLE);
				}
			} catch (e) {}
			WARM_HANDLE = null;
			WARM_KIND = null;
			return true;
		};
		diag.semanticWarm = function (items) {
			semLoad(items || []);
			return diag.semanticStatus();
		};

		/* ---------------- 候选对象 ---------------- */

		/**
		 * 评测反馈：重建候选会丢掉宿主字段（label、动态状态等）。
		 * 这里改成「保留原对象全部字段，只做增量覆盖」。
		 * description 仅在原文更长时才换成短描述，避免覆盖宿主已给的短文案。
		 */
		function asCandidate(it, extra) {
			var out = {};
			var k;
			for (k in it) {
				if (Object.prototype.hasOwnProperty.call(it, k)) out[k] = it[k];
			}
			var short = SHORT[it.name];
			// 宿主的「用户专用 · 」状态提示不能被静态短描述覆盖。
			// 这里刻意不用正则：模板字面量会把 \s 吞成 s，之前的 /^用户专用\s·/ 就变成了 /^用户专用s·/。
			var descStr = String(it.description || '');
			var userOnly = it.modelInvocable === false || descStr.indexOf('用户专用') === 0;
			if (short && !userOnly && (!it.description || String(it.description).length > short.length)) {
				out.description = short;
			}
			if (extra) {
				for (k in extra) {
					if (Object.prototype.hasOwnProperty.call(extra, k)) out[k] = extra[k];
				}
			}
			return out;
		}

		/* ---------------- 分组（自适应） ---------------- */

		/**
		 * 分组不是越多越好：条目少的时候，标题行比条目本身还占地方。
		 *
		 * 规则（设计推断；阈值需用埋点校准，不是论文结论）：
		 *   · 可见条目 < 12            → 不分组，纯名称排序
		 *   · 组内 < 3 条的碎组         → 并入「· 其他」
		 *   · 有效组 < 3               → 不分组
		 *
		 * 小语料（3 个技能）不该出现 3 个标题；碎组（1 条）也不该独占一个标题。
		 */
		var MIN_TOTAL_FOR_GROUPS = 12;
		var MIN_GROUP_SIZE = 3;
		var MIN_EFFECTIVE_GROUPS = 3;
		var MERGED_LABEL = '· 其他';

		function decorateGroups(items) {
			if (!items || typeof items.length !== 'number' || items.length === 0) return items;

			// 1) 按展示类分桶
			var buckets = {};
			var order = [];
			var i;
			var it;
			for (i = 0; i < items.length; i++) {
				it = items[i];
				if (!it || typeof it.name !== 'string') continue;
				var key = MAP[it.name];
				var cid = key && CATS[key] ? key : 'misc';
				if (!buckets[cid]) {
					buckets[cid] = [];
					order.push(cid);
				}
				buckets[cid].push(it);
			}

			// 2) 判定形态。misc 单独处理：它本身就是兜底桶，
			//    语义是「判不出来」，不该和「零散小类合并」混成同一个「· 其他」。
			var big = [];
			var small = [];
			for (i = 0; i < order.length; i++) {
				var id = order[i];
				if (buckets[id].length >= MIN_GROUP_SIZE || id === 'misc') big.push(id);
				else small.push(id);
			}
			var effective = big.length + (small.length ? 1 : 0);
			var grouped = items.length >= MIN_TOTAL_FOR_GROUPS && effective >= MIN_EFFECTIVE_GROUPS;

			// 3) 组装
			var rows = [];
			var mergedCount = 0;
			for (i = 0; i < small.length; i++) mergedCount += buckets[small[i]].length;
			for (i = 0; i < order.length; i++) {
				var cid2 = order[i];
				var meta = CATS[cid2] || CATS.misc;
				var merged = grouped && big.indexOf(cid2) < 0;
				var rowOrder = grouped ? (merged ? 998 : meta.order) : 0;
				var bucket = buckets[cid2];
				// 标题带数量：让人一眼知道这一类有多少个，不用数
				var label = merged ? MERGED_LABEL + ' · ' + mergedCount : meta.label + ' · ' + bucket.length;
				for (var j = 0; j < bucket.length; j++) {
					rows.push({
						cand: asCandidate(bucket[j], grouped ? { section: label } : null),
						order: rowOrder,
						label: label,
						name: bucket[j].name
					});
				}
			}

			// 4) 排序：分组时按「组序 → 组名 → 名称」；不分组时纯名称。
			//    用 label 而不是 cat —— 多个碎类会并入同一个「· 其他」，
			//    若按 cat 排，那个组内部就不是名称序了（实测已暴露）。
			rows.sort(function (a, b) {
				if (grouped && a.order !== b.order) return a.order - b.order;
				if (grouped && a.label !== b.label) return String(a.label).localeCompare(String(b.label));
				return String(a.name).localeCompare(String(b.name));
			});

			diag.grouping = { total: items.length, grouped: grouped, groups: grouped ? effective : 0 };

			var out = [];
			for (i = 0; i < rows.length; i++) out.push(rows[i].cand);
			return out;
		}

		/* ---------------- 语义检索（可选增强，失败自动降级） ---------------- */

		/**
		 * 为什么需要：中文别名是人工词表，只覆盖手写过的技能。
		 * 实测 50 个 GitHub 下载的英文技能，中文意图召回 0/6 —— 词表不随技能库扩张。
		 *
		 * 方案：浏览器里跑一个小型中英双语向量模型（bge-small-zh-v1.5，量化后约 30MB）。
		 *   1. 首次打开菜单时后台加载（不阻塞检索，加载期间走别名逻辑）
		 *   2. 技能库向量化一次，结果按 base64 存 localStorage，下次秒开
		 *   3. 查询时只 embed 一次（实测 9–41ms），按余弦相似度补充召回
		 *
		 * 语义结果只做「补充」，不改变别名/精确名的既有顺序 —— 避免一次模型升级把老行为打乱。
		 * 任何环节失败（CSP、离线、模型下载失败）都只置为 unavailable，检索退回原逻辑。
		 */
		var SEM = {
			status: 'idle', // idle | loading | ready | unavailable
			pipe: null,
			vectors: null,
			error: null,
			model: 'Xenova/bge-small-zh-v1.5',
			libUrl: 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2',
			cacheKey: 'dsh.skillcat.vec.v1',
			minCos: 0.45,
			maxAdd: 20,
			/** 目录指纹：内容变了就作废索引，不能只看条数 */
			fp: '',
			/** 索引任务代次：目录一变就 +1，旧任务的结果一律丢弃 */
			gen: 0
		};

		function hashStr(s) {
			var h = 5381;
			for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
			return (h >>> 0).toString(36);
		}

		/**
		 * 目录指纹：参与向量化的文本内容 + 模型标识 + 向量化参数。
		 * 不能用描述「长度」代替内容 —— 同长度改写（alpha→bravo）会被判成没变。
		 */
		function catalogFingerprint(all) {
			var parts = [];
			for (var i = 0; i < all.length; i++) {
				var it = all[i] || {};
				parts.push(String(it.name || '') + '\u0001' + hashStr(String(it.description || '')));
			}
			parts.sort();
			return hashStr(parts.join('|') + '#' + SEM.model + '#' + SEM.minCos + ',' + SEM.maxAdd) + ':' + all.length;
		}

		function b64enc(v) {
			var u = new Uint8Array(v.buffer || v);
			var s = '';
			for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
			return btoa(s);
		}

		function b64dec(s) {
			var bin = atob(s);
			var u = new Uint8Array(bin.length);
			for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
			return new Float32Array(u.buffer);
		}

		function cosine(a, b) {
			var d = 0;
			var n = Math.min(a.length, b.length);
			for (var i = 0; i < n; i++) d += a[i] * b[i];
			return d;
		}

		/** 自动化测试注入点：生产环境为 null，可控制导入与 pipeline 的完成时机 */
		var SEM_HOOKS = null;

		/**
		 * 语义索引预热。
		 *
		 * 两条原则：
		 *   1. **不在菜单打开路径上开工** —— 以前一次按 / 就 import CDN + 建 pipeline。
		 *   2. **用“浏览器空闲”决定何时开工，而不是拍一个秒数** ——
		 *      6 秒是拍的，用户可能正好在那一刻打字；requestIdleCallback 只有在主线程真的空下来
		 *      才回调，忙的时候自动推迟，这才是「不抢用户线程」的正确判据。
		 *
		 * 另外 pipeline 里的 ONNX 走 Worker（proxy=true），进一步避免主线程卡顿。
		 */
		var WARM_HANDLE = null;
		var WARM_KIND = null;
		var WARM_TIMEOUT_MS = 15000; // rIC 的最长等待：再忙也不能永远不预热
		var IDLE_GUARD_MS = 1200; // 距上次交互不足这个时间就继续等
		var LAST_INTERACTION = 0;

		function scheduleWarm(items) {
			if (SEM.status !== 'idle' || !items || !items.length) return;
			// 测试注入点在场时立即预热：用例要的是可控时序
			if (SEM_HOOKS) {
				SEM.warmStartedAt = Date.now();
				diag.warmStarted = (diag.warmStarted || 0) + 1;
				semLoad(items);
				return;
			}
			if (WARM_HANDLE) return;
			diag.warmScheduled = (diag.warmScheduled || 0) + 1;

			var start = function (deadline) {
				WARM_HANDLE = null;
				WARM_KIND = null;
				try {
					if (SEM.status !== 'idle') return;
					if (Date.now() - LAST_INTERACTION < IDLE_GUARD_MS) {
						scheduleWarm(items); // 用户正在动，继续等空闲
						return;
					}
					if (typeof document !== 'undefined' && document.hidden) {
						scheduleWarm(items);
						return;
					}
					// rIC 回调但时间预算已耗尽且不是超时触发 → 让给用户
					if (
						deadline &&
						typeof deadline.timeRemaining === 'function' &&
						deadline.didTimeout !== true &&
						deadline.timeRemaining() <= 0
					) {
						scheduleWarm(items);
						return;
					}
					SEM.warmStartedAt = Date.now();
					diag.warmStarted = (diag.warmStarted || 0) + 1;
					semLoad(items);
				} catch (e) {
					diag.degraded = 'warm:' + (e && e.message);
				}
			};

			try {
				if (typeof requestIdleCallback === 'function') {
					WARM_KIND = 'idle';
					WARM_HANDLE = requestIdleCallback(start, { timeout: WARM_TIMEOUT_MS });
					return;
				}
			} catch (e) {}
			// 没有 rIC（老环境）：退回短定时器，但同样要求“超过 IDLE_GUARD_MS 没交互”
			WARM_KIND = 'timer';
			WARM_HANDLE = setTimeout(function () {
				start(null);
			}, IDLE_GUARD_MS + 300);
		}

${runtimeSource("runtime-semantic.mjs")}

		/** 返回 [{name, s}]，按相似度降序；未就绪或失败返回 null */
		function semRank(query) {
			if (SEM.status !== 'ready' || !SEM.pipe || !SEM.vectors) return Promise.resolve(null);
			var generation = SEM.gen;
			var pipe = SEM.pipe;
			var vectors = SEM.vectors;
			return Promise.resolve()
				.then(function () {
					return pipe(query, { pooling: 'mean', normalize: true });
				})
				.then(function (r) {
					if (generation !== SEM.gen) return null;
					var q = new Float32Array(r.data);
					var scored = [];
					for (var i = 0; i < vectors.length; i++) {
						var s = cosine(q, vectors[i].vec);
						if (s >= SEM.minCos) scored.push({ name: vectors[i].name, s: s });
					}
					scored.sort(function (a, b) {
						return b.s - a.s;
					});
					return scored.slice(0, SEM.maxAdd);
				})
				.catch(function (e) {
					if (generation === SEM.gen) SEM.error = String((e && e.message) || e);
					return null;
				});
		}

		/* ---------------- 分类筛选 + 面包屑 ---------------- */

		/**
		 * 输入分类名（「设计」「动效」「文档」…）直接跳到该分类。
		 * 这是「分类页」在这套菜单里的可行形态：宿主的下钻会在点击后关闭菜单，
		 * 没法常驻两级页面，所以用「输入即跳转」实现同一个效果。
		 */
		function matchCat(q) {
			var n = normalize(q);
			if (!n || n.length < 1) return null;
			for (var id in CATNAME) {
				var nm = normalize(CATNAME[id]);
				if (!nm) continue;
				if (nm.indexOf(n) >= 0) return id;
			}
			return null;
		}

		/**
		 * 面包屑 = 分类跳转条。
		 * 根视图返回 9 个分类芯片（名字 + 数量），点一下跳到该类；
		 * 筛选视图返回「全部 + 当前类」，当前类不可点（current: true）。
		 */
${runtimeSource("runtime-header.mjs")}

		/** 检索：本地重排后再包成菜单候选项 */
		function decorateRanked(items) {
			var out = [];
			for (var i = 0; i < items.length; i++) {
				out.push(asCandidate(items[i], null));
			}
			return out;
		}

		/* ---------------- 样式微调 ---------------- */

		/**
		 * 菜单行是宿主的 CSS Module：描述用 flex:1 + text-align:right，
		 * 于是名字靠左、描述顶到最右，中间空出一大段。
		 * 这里把描述改回左对齐，让它紧贴技能名。
		 * 选择器用 [class*="itemDescription"]，避免宿主 hash 前缀（pc3rQa_）升级后失配。
		 */
		var STYLE_ID = 'dsh-skillcat-style';
		// 注意：这段在模板字符串里，注释和代码都不要写反斜杠加 n（会被当转义变成真实换行，生成文件就语法错误）。
		// CSS 不需要换行，直接单行。
		var STYLE_CSS = '[class*="itemDescription"]{text-align:left !important}';

		function injectStyle() {
			try {
				if (typeof document === 'undefined' || !document.head) return;
				if (document.getElementById(STYLE_ID)) return;
				var el = document.createElement('style');
				el.id = STYLE_ID;
				el.textContent = STYLE_CSS;
				document.head.appendChild(el);
			} catch (e) {}
		}

		function removeStyle() {
			try {
				if (typeof document === 'undefined') return;
				var el = document.getElementById(STYLE_ID);
				if (el && el.parentNode) el.parentNode.removeChild(el);
			} catch (e) {}
		}

		/* ---------------- 接管内置技能源 ---------------- */

		var SOURCE_TRIGGER = '/';
		var SOURCE_NAME = 'skill';
		var FLAG = '__skillCategories';
		var ATTACH_TIMEOUT_MS = 30000;
		var ATTACH_INTERVAL_MS = 300;

		function findSource(svc) {
			var list = svc && svc.live && svc.live.sources;
			if (!list || typeof list.length !== 'number') return null;
			for (var i = 0; i < list.length; i++) {
				var s = list[i];
				if (s && s.trigger === SOURCE_TRIGGER && s.name === SOURCE_NAME) return s;
			}
			return null;
		}

		/**
		 * 归因状态按会话分开。评测复现：两个会话并发时，选中 gsap-core 会被
		 * 记成上一个会话的 tdd 查询、rank=-1。
		 */
		var MAX_TOTAL = 60;
		var state = {};
		var wrappedAll = [];

		function sid(session) {
			try {
				if (session && typeof session === 'object') {
					return String(session.id || session.sessionId || session.key || '__');
				}
			} catch (e) {}
			return '__';
		}

		function remember(session, query, list) {
			state[sid(session)] = {
				q: query,
				names: list.map(function (x) { return x.name; })
			};
		}

		/* ---------------- 绕过渲染进程的会话级缓存 ---------------- */

		/**
		 * 内置 "/" 源把技能目录缓存在 fetches: Map<sessionId, …> 里，一个会话只取一次，
		 * 只有换 preset / 重载页面才会清。所以装完技能光是重开菜单看不到新的。
		 *
		 * 这里直接走它同一条 RPC（ctx.remote.skills.list），自己拿一份新鲜的：
		 * 变了就是用新的，失败就退回内置缓存（至少菜单还能用）。
		 */
${runtimeSource("runtime-catalog.mjs")}

		function wrap(src) {
			if (!src || src[FLAG]) return false;
			var original = src.candidates;
			var originalPick = src.onPick;
			var originalHeader = src.header;
			if (typeof original !== 'function') return false;

			// 面包屑：菜单正上方显示「110 个技能 · 9 类」；筛选时变成「全部 › 设计与视觉」
			src.header = function (session, ctx) {
				try {
					return buildHeader(session, ctx);
				} catch (e) {
					diag.degraded = 'header:' + (e && e.message);
					return undefined;
				}
			};

			src.candidates = function (session, req) {
				var self = this === undefined ? src : this;
				try { LAST_INTERACTION = Date.now(); } catch (e) {}
				var query = req && typeof req.query === 'string' ? req.query : '';
                var signal = req && req.signal;
                if (signal && signal.aborted) return Promise.resolve([]);
                var queryKey = sid(session);
                var generation = (QUERY_GENERATIONS.get(queryKey) || 0) + 1;
                QUERY_GENERATIONS.set(queryKey, generation);
                var lifetime = LIFETIME;
                function current() {
                    return lifetime === LIFETIME && QUERY_GENERATIONS.get(queryKey) === generation && !(signal && signal.aborted);
                }

				// 与宿主保持一致：subagent 会话没有技能目录。
				// 必须返回 Promise —— 宿主对 candidates 的结果直接 .then()。
				try {
					var sessSvc = serviceOf(CTX, 'sessions');
					var sidv = session && (session.sessionId || session.id);
					if (sessSvc && typeof sessSvc.subagentAddress === 'function' && sidv !== undefined) {
						if (sessSvc.subagentAddress(sidv) !== undefined) return Promise.resolve([]);
					}
				} catch (e) {}

				// 取两份：
				//   1) 空查询的全量 —— 中文意图要靠别名在本地重排
				//   2) 原查询的模糊结果 —— 兜住「只打两个字母」的中途输入
				// 两个分支独立容错：一路失败不应让整个请求拒绝。
				var fullP = Promise.resolve()
					.then(function () {
						// 优先自己取一份新鲜目录，绕开内置源的会话级缓存
						return bounded(freshCatalog(CTX, session), 80, null);
					})
					.then(function (list) {
                        if (!current()) return null;
                        if (!Array.isArray(list)) list = cachedCatalog(session);
						// 「取到空目录」是合法结果（技能全被删光），不能当成失败去回退旧缓存 ——
						// 否则删掉的技能会被内置缓存补回来。
						if (Array.isArray(list)) {
							var out = [];
							for (var i = 0; i < list.length; i++) {
								var s = list[i];
								if (s && typeof s.name === 'string') {
									var desc = s.description || '';
									// 保留宿主的「用户专用」状态提示，不要被静态短描述吃掉
									if (s.modelInvocable === false) desc = '用户专用 · ' + desc;
									out.push({ name: s.name, description: desc, modelInvocable: s.modelInvocable });
								}
							}
							diag.freshUsed = (diag.freshUsed || 0) + 1;
							return out;
						}
						diag.freshFallback = (diag.freshFallback || 0) + 1;
						return bounded(Promise.resolve().then(function () { return original.call(self, session, { query: '', signal: signal }); }), 120, null);
					})
					.catch(function (e) {
						if (current()) diag.degraded = 'full:' + (e && e.message);
						return null;
					});

				var looseP = query
					? Promise.resolve()
							.then(function () {
								return original.call(self, session, { query: query, signal: req && req.signal });
							})
							.catch(function (e) {
								if (current()) diag.degraded = 'fuzzy:' + (e && e.message);
								return null;
							})
					: Promise.resolve(null);

				// 语义补充改成「需要时才取，且带预算」——
				// 之前 Promise.all 会一直等语义模型，模型卡住时连精确命中都出不来。
				var SEM_BUDGET_MS = 250;
				function withBudget(p, ms) {
					return new Promise(function (resolve) {
						var done = false;
						var t = setTimeout(function () {
							if (done) return;
							done = true;
							diag.semBudgetHit = (diag.semBudgetHit || 0) + 1;
							resolve(null);
						}, ms);
						Promise.resolve(p).then(
							function (v) {
								if (done) return;
								done = true;
								clearTimeout(t);
								resolve(v);
							},
							function () {
								if (done) return;
								done = true;
								clearTimeout(t);
								resolve(null);
							}
						);
					});
				}

				return Promise.all([fullP, bounded(looseP, 50, null)]).then(function (res) {
                    if (!current()) return [];
					var all = res[0];
					var loose = res[1];

					// 全量分支失败：退回内置结果（至少菜单还能用）
					if (all === null) {
						if (loose && loose.length) {
							remember(session, query, loose);
							return decorateRanked(loose);
						}
						return [];
					}
					if (!all.length) {
						// 空目录：仍然要让计数/指纹归零，但不启动模型加载
						syncCatalog(all, session);
						return all;
					}

					// 先让新装的技能进入分类体系，后续分组/检索/面包屑都基于它
					syncCatalog(all, session);

					if (!query) {
						// 以前在这里直接 semLoad：菜单一打开就去 import CDN 上的 transformers
						// 并建 pipeline，ONNX 初始化跑在渲染主线程，首次 1–3 秒的卡顿就是这么来的。
						// 浏览根本用不到向量，改成纯后台空闲预热，且要等菜单关掉。
						scheduleWarm(all);
						var grouped = decorateGroups(all);
						remember(session, '', grouped);
						log({ q: '', n: grouped.length });
						return grouped;
					}

					var ranked = rankCandidates(all, query, ALIASES, { curated: CURATED }) || [];

					// 分类筛选：输入分类名时直接返回该类全部技能（「分类页」的可行形态）
					var catId = matchCat(query);
					if (catId) {
						var subset = [];
						for (var ci = 0; ci < all.length; ci++) {
							if ((MAP[all[ci].name] || 'misc') === catId) subset.push(all[ci]);
						}
						if (subset.length) {
							subset.sort(function (a, b) {
								return String(a.name).localeCompare(String(b.name));
							});
							remember(session, query, subset);
							log({ q: String(query).slice(0, 40), n: subset.length, cat: catId });
							return decorateRanked(subset);
						}
					}

					// 当前目录是唯一依据：不在里面的名字一律不进候选（删掉的不能被旧缓存补回）
					var inCatalog = {};
					for (var n = 0; n < all.length; n++) inCatalog[all[n].name] = 1;

					// 合并第一层：本地排在前，内置模糊结果补在后（保证中途输入不掉召回）
					var seen = {};
					for (var i = 0; i < ranked.length; i++) seen[ranked[i].name] = 1;
					for (var j = 0; loose && j < loose.length; j++) {
						var ln = loose[j] && loose[j].name;
						if (!ln || !inCatalog[ln] || seen[ln]) continue;
						ranked.push(loose[j]);
						seen[ln] = 1;
					}

					// 语义只在「有预算的补充」里出现：已精确命中就不必等它
					var exact = false;
					var qq = String(query).trim().toLowerCase();
					for (var e2 = 0; e2 < all.length; e2++) {
						if (String(all[e2].name).toLowerCase() === qq) {
							exact = true;
							break;
						}
					}
					var semTail =
						SEM.status === 'ready' && !exact
							? withBudget(semRank(query), SEM_BUDGET_MS)
							: Promise.resolve(null);

					return semTail.then(function (sem) {
                        if (!current()) return [];
						// 合并第二层：语义命中补在最后（只补召回，不改既有顺序）
						if (sem && sem.length) {
							var byName = {};
							for (var a = 0; a < all.length; a++) byName[all[a].name] = all[a];
							for (var b = 0; b < sem.length; b++) {
								var hit = byName[sem[b].name];
								if (hit && !seen[hit.name]) {
									ranked.push(hit);
									seen[hit.name] = 1;
								}
							}
							diag.semanticHits = sem.length;
						}

						// 合并后仍需总上限，否则本地 40 + 宿主结果可能上千条
						if (ranked.length > MAX_TOTAL) ranked = ranked.slice(0, MAX_TOTAL);

						remember(session, query, ranked);
						log({ q: String(query).slice(0, 40), n: ranked.length, sem: SEM.status === 'ready' ? 1 : 0 });
						return decorateRanked(ranked);
					});
				});
			};

			// 记录选中项与名次（不改变原有插入行为）
			if (typeof originalPick === 'function') {
				src.onPick = function (pick) {
					// 分类芯片被点：改写输入框为「/分类名」并让菜单继续开着，
					// 等价于用户自己敲了分类名 —— 这是宿主唯一支持跳转的手段。
					try {
						if (pick && pick.action === 'drill' && pick.candidate) {
							var v = pick.candidate.value;
							if (typeof v === 'string') {
								if (v === 'root') {
									log({ nav: 'root' });
									return { text: '/', continue: true };
								}
								if (v.indexOf('cat:') === 0) {
									var cid = v.slice(4);
									var word = CATSHORT[cid] || CATNAME[cid] || cid;
									log({ nav: cid });
									return { text: '/' + word, continue: true };
								}
							}
						}
					} catch (e) {}
					try {
						var name = pick && pick.candidate ? pick.candidate.name : '';
						var st = state[sid(pick && pick.session)] || { q: '', names: [] };
						var rank = st.names.indexOf(name);
						log({ q: String(st.q).slice(0, 40), pick: name, rank: rank, qlen: st.q.length });
					} catch (e) {}
					return originalPick.apply(this, arguments);
				};
			}

			src[FLAG] = { original: original, originalPick: originalPick };
			wrappedAll.push({
				target: src,
				original: original,
				originalPick: originalPick,
				originalHeader: originalHeader,
				candidates: src.candidates,
				pick: src.onPick,
				header: src.header
			});
			diag.patched = true;
			diag.degraded = null;
			return true;
		}

		var timers = [];
		function attach(ctx, svc) {
			if (!svc) return;
			if (wrap(findSource(svc))) return;

			var start = function () {
				var began = Date.now();
				var timer = setInterval(function () {
					var s = findSource(svc);
					if (s) { clearInterval(timer); wrap(s); return; }
					if (Date.now() - began > ATTACH_TIMEOUT_MS) {
						clearInterval(timer);
						if (typeof console !== 'undefined') console.warn('[skill-categories] 未找到内置技能源');
					}
				}, ATTACH_INTERVAL_MS);
				timers.push(timer);
				return function () {
					clearInterval(timer);
					var at = timers.indexOf(timer);
					if (at >= 0) timers.splice(at, 1);
				};
			};

			if (ctx && typeof ctx.effect === 'function') ctx.effect(start, 'skill-categories: attach');
			else start();
		}

		function apply(ctx) {
			CTX = ctx;
			if (typeof window !== 'undefined') window.__dshSkillCategories = diag;
			injectStyle();

			// 声明依赖再取：直接 ctx.get('remote') 拿到的是会抛错的代理
			if (typeof ctx.inject === 'function') {
				try {
					// 关键：内置插件声明的是 "remote.skills" 这个面，
					// 只写 "remote" 拿到的仍是「取属性就抛错」的代理。
					ctx.inject(['remote', 'remote.skills'], function (scope) {
						try {
							REMOTE = scope.remote || (typeof scope.get === 'function' ? scope.get('remote') : null);
						} catch (e) {}
					});
				} catch (e) {}
			}

			var svc = typeof ctx.get === 'function' ? ctx.get('inputTriggers') : undefined;
			if (!svc) {
				if (typeof ctx.inject === 'function') {
					ctx.inject(['inputTriggers'], function (scope) { attach(scope, scope.get('inputTriggers')); });
				}
				return;
			}
			attach(ctx, svc);
		}

		exports.apply = apply;
		exports.inject = [];
		exports.diagnostics = diag;

		/**
		 * 评测复现：dispose 后 candidates / onPick 都没还原，标记仍在，查询仍带分类。
		 * 现在真正撤销：恢复本插件仍然拥有的函数、删标记、清状态。
		 * 如果期间已被别的插件再次包装（函数已不是我们装的那一个），就不覆盖它。
		 */
		exports.dispose = function () {
            clearCatalogs();
            HEADER_VIEWS.clear();
            SEM.gen++;
            SEM.status = 'idle';
            SEM.vectors = null;
            SEM.error = null;
            dropPipeline();
            VECTOR_CACHE.clear();
            VECTOR_CACHE_LOADED = false;
			for (var i = 0; i < timers.length; i++) clearInterval(timers[i]);
			timers.length = 0;

			if (flushTimer !== null) {
				try { clearTimeout(flushTimer); } catch (e) {}
				flushTimer = null;
			}
			flush();

			for (var wi = 0; wi < wrappedAll.length; wi++) {
				var w = wrappedAll[wi];
				if (!w || !w.target) continue;
				try {
					if (w.target.candidates === w.candidates) w.target.candidates = w.original;
					if (w.originalPick && w.target.onPick === w.pick) w.target.onPick = w.originalPick;
					if (w.target.header === w.header) {
						if (w.originalHeader === undefined) delete w.target.header;
						else w.target.header = w.originalHeader;
					}
					delete w.target[FLAG];
				} catch (e) {}
			}
			wrappedAll = [];
			state = {};
			removeStyle();
			diag.patched = false;
		};

		} catch (error) {
			if (typeof console !== 'undefined') console.error('[skill-categories] init failed:', error);
			exports.apply = function () {};
			exports.inject = [];
		}
		return module.exports;
	}
});
`;

const clientOut = clientSrc.split('3.4.0').join(JSON.stringify(VERSION));

/* 生成即验收：注释吞掉声明仍是合法 JS，语法检查发现不了，这里拦死在构建阶段 */
const badLines = clientOut
	.split(/\r?\n/)
	.filter((l) => /^\s*\/\/.*\t{2,}(var|let|const|function|return|if|for|while)\b/.test(l));
if (badLines.length) {
	throw new Error('产物 lint 失败：有语句被并进注释 ->\n' + badLines.slice(0, 3).join('\n'));
}
writeFileSync(join(OUT, 'lib', 'client.js'), clientOut, 'utf8');

/* ---------------------------- package.json ---------------------------- */

writeFileSync(
  join(OUT, 'package.json'),
  JSON.stringify(
    {
      name: 'dsh-skill-categories',
      version: VERSION,
      private: true,
      description: '给 DSH 的 / 菜单加技能分类分组：本地别名排序 + 9 类分组 + 埋点。',
      type: 'module',
      main: './lib/index.js',
      exports: {
        '.': './lib/index.js',
        './client': './lib/client.js',
        './package.json': './package.json',
      },
      files: ['lib', 'cordis.patch.yml'],
      dsh: {
        bundle: { patch: './cordis.patch.yml' },
        client: { platform: 'web', inject: [] },
      },
    },
    null,
    2
  ),
  'utf8'
);

/* ---------------------------- bundle 装配层 ---------------------------- */

writeFileSync(
  join(OUT, 'cordis.patch.yml'),
  `# dsh-skill-categories 的 bundle 装配层。
#
# 宿主按 package.json 的 dsh.bundle.patch 找到本文件，装配时插入下面这一行。
# 不要在 profile 的 cordis.patch.yml 里再插一次 —— 两处都插会让插件注册两次。
- insert:
    - id: skill-categories
      name: dsh-skill-categories
      config: {}
`,
  'utf8'
);

console.log(`插件已生成 → ${OUT}`);
console.log(`  ${stats.skills} 个技能 / ${stats.groups} 个展示类 / ${Object.keys(aliases).length} 份入口词`);
console.log(`  client.js ${(clientSrc.length / 1024).toFixed(1)} KB`);
