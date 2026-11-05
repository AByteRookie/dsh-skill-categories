/**
 * make-shots.mjs — 生成 README 用的界面示意图
 *
 * 不是截图：DSH 桌面版没有暴露调试端口，无法对真实窗口截图。
 * 但图里的**数据是真的** —— 面包屑、分组、计数、条目顺序都来自
 * 现场加载的 client bundle（pluginDir 里那份），不是手写死的。
 *
 * 输出：docs/menu-empty.png / docs/menu-query.png
 * 用法：node docs/make-shots.mjs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pluginDir } from '../paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const OUT = HERE;

const CLIENT = join(pluginDir(), 'lib', 'client.js');
const INDEX = join(REPO, 'index.json');
for (const [label, p] of [['client bundle', CLIENT], ['index.json', INDEX]]) {
  if (!existsSync(p)) {
    console.error(`缺少 ${label}：${p}\n先跑 node setup.mjs`);
    process.exit(1);
  }
}
console.log('bundle  ' + createHash('sha256').update(readFileSync(CLIENT)).digest('hex').slice(0, 16));
console.log('index   ' + INDEX);

const idx = JSON.parse(readFileSync(INDEX, 'utf8').replace(/^\uFEFF/, ''));
const visible = idx.skills.filter((s) => s.userInvocable);

/* ---------------- 在仿真宿主里跑真实 bundle ---------------- */

const store = new Map();
const win = {
  __ModuleLoader__: { load: (c) => (captured = c) },
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  document: { createElement: () => ({ dataset: {}, style: {}, setAttribute() {}, appendChild() {} }), querySelector: () => null, head: { appendChild() {} } },
  addEventListener() {},
  removeEventListener() {},
  setTimeout,
  clearTimeout,
  console,
  Date,
  JSON,
  Math,
  Float32Array,
  Uint8Array,
  String,
  Number,
  Object,
  Array,
  Error,
  Promise,
  RegExp,
  isNaN,
  parseInt,
  parseFloat,
  encodeURIComponent,
  decodeURIComponent,
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
};
let captured = null;
new Function('window', 'globalThis', readFileSync(CLIENT, 'utf8'))(win, win);
const api = captured.factory(() => {
  throw new Error('no require');
});

const catalog = visible.map((s) => ({ name: s.name, description: s.desc }));
const src = {
  trigger: '/',
  name: 'skill',
  order: 2,
  async candidates(session, req) {
    const q = String((req && req.query) || '').trim().toLowerCase().replace(/\s+/g, '');
    if (!q) return catalog;
    return catalog.filter((s) => s.name.toLowerCase().indexOf(q) >= 0);
  },
  onPick: () => ({ text: '/' }),
};
const svc = { live: { sources: [src] } };
api.apply({ get: (n) => (n === 'inputTriggers' ? svc : undefined), inject: (d, cb) => cb({ get: () => svc }), effect: (f) => f() });

const crumbs = src.header({ sessionId: 'shot' }, { query: '', quoted: false, drilled: false });
const items = await src.candidates({ sessionId: 'shot' }, { query: '', signal: {} });
const queryText = '做落地页';
const hits = await src.candidates({ sessionId: 'shot' }, { query: queryText, signal: {} });
api.dispose();

console.log(`面包屑 ${crumbs.length} 项 / 分组条目 ${items.length} 条 / 查询命中 ${hits.length} 条`);

/* ---------------- HTML ---------------- */

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const CSS = `
  :root{
    --bg:#ffffff; --panel:#ffffff; --line:#e8e8ec; --line-soft:#f0f0f4;
    --ink:#1b1b1f; --ink-2:#5c5c66; --ink-3:#9a9aa6;
    --chip:#f4f4f7; --chip-hover:#ececf2; --accent:#3b6cff; --accent-soft:#eaf0ff;
    --shadow:0 18px 48px rgba(20,20,40,.16), 0 2px 8px rgba(20,20,40,.06);
  }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;background:#eef0f4;}
  body{
    font:14px/1.45 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    color:var(--ink);
    -webkit-font-smoothing:antialiased;
    padding:28px;
  }
  .stage{display:flex;justify-content:center;}
  .menu{
    width:720px;background:var(--panel);border:1px solid var(--line);
    border-radius:14px;box-shadow:var(--shadow);overflow:hidden;
  }
  .crumbs{
    display:flex;flex-wrap:wrap;gap:6px;padding:12px 14px 10px;
    border-bottom:1px solid var(--line-soft);background:#fbfbfd;
  }
  .crumb{
    font-size:12px;padding:3px 9px;border-radius:999px;background:var(--chip);
    color:var(--ink-2);white-space:nowrap;
  }
  .crumb.active{background:var(--accent-soft);color:#2b52c9;font-weight:600}
  .sheet{padding:6px 0 8px;max-height:none}
  .section{
    display:flex;align-items:center;gap:8px;padding:12px 16px 6px;
    font-size:12px;font-weight:600;color:var(--ink-2);letter-spacing:.2px;
  }
  .glyph{color:var(--accent);font-size:12px}
  .count{margin-left:auto;color:var(--ink-3);font-weight:500}
  .item{display:flex;align-items:baseline;gap:10px;padding:4px 16px 4px 30px;}
  .item .name{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;color:var(--ink);flex:0 0 auto;white-space:nowrap}
  .item .desc{font-size:12px;color:var(--ink-3);flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .item.hit{background:var(--accent-soft);}
  .item.hit .name{color:#1f43ad;font-weight:600}
  .input{
    display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--line-soft);
  }
  .slash{
    width:22px;height:22px;border-radius:6px;background:var(--chip);color:var(--ink-2);
    display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;
  }
  .field{font-size:14px;color:var(--ink);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  .caret{display:inline-block;width:1.5px;height:15px;background:var(--accent);vertical-align:-2px;margin-left:1px}
  .hint{margin-left:auto;font-size:11px;color:var(--ink-3)}
  .more{padding:6px 16px 2px 30px;font-size:12px;color:var(--ink-3)}
  .footer{padding:10px 16px;border-top:1px solid var(--line-soft);font-size:11.5px;color:var(--ink-3);background:#fbfbfd}
  .section{scroll-margin:0}
`;

const page = (title, body) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head>
<body><div class="stage"><div class="menu">${body}</div></div></body></html>`;

/* --- 图 1：空查询，按分类分组 --- */

const crumbHtml = crumbs.map((c, i) => `<span class="crumb${i === 0 ? ' active' : ''}">${esc(c.label)}</span>`).join('');

const grouped = new Map();
for (const it of items) {
  const k = it.section || '(未分组)';
  if (!grouped.has(k)) grouped.set(k, []);
  grouped.get(k).push(it);
}

const LIMIT = 3;
const MAX_SECTIONS = 3;
let shownSections = 0;
let sectionsHtml = '';
for (const [label, list] of grouped) {
  if (shownSections >= MAX_SECTIONS) break;
  shownSections++;
  const glyph = label.match(/^(\S)\s/) ? label.match(/^(\S)\s/)[1] : '·';
  const text = label.replace(/^\S\s/, '');
  sectionsHtml += `<div class="section"><span class="glyph">${esc(glyph)}</span><span>${esc(text)}</span></div>`;
  for (const it of list.slice(0, LIMIT)) {
    sectionsHtml += `<div class="item"><span class="name">${esc(it.name)}</span><span class="desc">${esc(it.description || '')}</span></div>`;
  }
  if (list.length > LIMIT) sectionsHtml += `<div class="more">…还有 ${list.length - LIMIT} 个</div>`;
}

let shot1 = page(
  '技能分类菜单',
  `<div class="input"><span class="slash">/</span><span class="field"><span class="caret"></span></span><span class="hint">Esc 关闭</span></div>
   <div class="crumbs">${crumbHtml}</div><div class="sheet">${sectionsHtml}</div>`
);

/* --- 图 2：中文查询命中 --- */

let hitsHtml = '';
for (const [hi, it] of hits.slice(0, 6).entries()) {
  const kind = it.section ? `<span class="desc">${esc(String(it.section).replace(/^\S\s/, ''))}</span>` : '';
  // 只有第一项是「选中」状态，其余保持普通行
  const cls = hi === 0 ? 'item hit' : 'item';
  hitsHtml += `<div class="${cls}"><span class="name">${esc(it.name)}</span>${kind}<span class="desc">${esc(it.description || '')}</span></div>`;
}

const shot2 = page(
  '中文查询',
  `<div class="input"><span class="slash">/</span><span class="field">${esc(queryText)}<span class="caret"></span></span><span class="hint">↑↓ 选择 · Enter 执行</span></div>
   <div class="sheet">${hitsHtml}</div>`
);

const footerHtml = `<div class="footer">共 ${visible.length} 个技能 · ${crumbs.length} 个分类 · 输入中文即可检索</div>`;
shot1 = shot1.replace('</div></div></body>', footerHtml + '</div></div></body>');

writeFileSync(join(OUT, 'menu-empty.html'), shot1, 'utf8');
writeFileSync(join(OUT, 'menu-query.html'), shot2, 'utf8');

/* ---------------- 截图 ---------------- */

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p));

if (!EDGE) {
  console.error('找不到 Edge/Chrome，无法截图。HTML 已生成，可手动截图。');
  process.exit(1);
}

const shoot = (html, png, w, h) => {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=2',
    `--window-size=${w},${h}`,
    `--screenshot=${png}`,
    `file:///${html.replace(/\\/g, '/')}`,
  ];
  const r = spawnSync(EDGE, args, { encoding: 'utf8', timeout: 90000 });
  if (!existsSync(png)) {
    console.error('截图失败：' + (r.stderr || '').split(/\r?\n/).slice(-4).join(' | '));
    return false;
  }
  console.log(`  ✓ ${png}  ${(statSync(png).size / 1024).toFixed(1)} KB`);
  return true;
};

mkdirSync(OUT, { recursive: true });
const okAll =
  shoot(join(OUT, 'menu-empty.html'), join(OUT, 'menu-empty.png'), 780, 655) &&
  shoot(join(OUT, 'menu-query.html'), join(OUT, 'menu-query.png'), 780, 258);

process.exit(okAll ? 0 : 1);
