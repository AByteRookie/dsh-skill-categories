/**
 * asar-skills.mjs — 解析 DSH 的 app.asar，列出内置（bundled）技能
 *
 * 背景：DSH 的技能来自两个根：
 *   1. 打包在 app.asar 内的 skills/ 目录树（随产品发布，用户改不了）
 *   2. 用户目录 ~/.agents/skills（用户自装）
 * 分类功能必须同时覆盖两者，否则索引是残缺的。
 *
 * asar 容器格式（Pickle）：
 *   [0..7]   外层 pickle（长度字段宽度 + payload 长度）
 *   [8..11]  内层 pickle payload 长度
 *   [12..15] header JSON 字节数
 *   [16..]   header JSON（UTF-8）
 *   dataBase = 8 + payloadSize，向下 4 字节对齐
 * 文件条目里的 offset 是相对 dataBase 的。
 *
 * 用法：
 *   node asar-skills.mjs            # 自动发现 app.asar
 *   node asar-skills.mjs --asar <path>
 *   DSH_ASAR=<path> node asar-skills.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, findAsar } from './paths.mjs';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const ASAR = findAsar(arg('--asar'));
const OUT = join(ROOT, 'bundled.json');

if (!ASAR) {
  console.error('找不到 app.asar。三种解决办法：');
  console.error('  1. 先启动一次 DSH（脚本会从运行中的进程反查安装位置）');
  console.error('  2. node asar-skills.mjs --asar "<DSH安装目录>/resources/app.asar"');
  console.error('  3. 设置环境变量 DSH_ASAR');
  process.exit(2);
}

const buf = readFileSync(ASAR);

// 头部布局（实测）：[4]=payloadSize  [12]=jsonByteLength  [16..]=header JSON
const payloadSize = buf.readUInt32LE(4);
const jsonByteLength = buf.readUInt32LE(12);
const JSON_AT = 16;
const jsonText = buf.subarray(JSON_AT, JSON_AT + jsonByteLength).toString('utf8');
const dataBase = 8 + payloadSize;
const dataBaseAligned = dataBase % 4 === 0 ? dataBase : dataBase + (4 - (dataBase % 4));

let header;
try {
  header = JSON.parse(jsonText);
} catch (e) {
  console.error('asar header JSON 解析失败:', e.message);
  process.exit(1);
}

console.log(`asar: ${ASAR}`);
console.log(`header JSON: ${jsonByteLength} bytes, dataBase=${dataBase}`);

/** 递归遍历 asar 目录树 */
function walk(node, prefix, acc) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (entry.files) walk(entry, p, acc);
    else if (entry.size !== undefined) acc.push({ path: p, size: entry.size, offset: Number(entry.offset) });
  }
}

const all = [];
walk(header, '', all);
console.log(`asar 内文件总数: ${all.length}`);

function readEntry(e) {
  const start = dataBase + e.offset;
  return buf.subarray(start, start + e.size);
}

const skillEntries = all.filter((e) => /(^|\/)SKILL\.md$/.test(e.path));
console.log(`SKILL.md 条目: ${skillEntries.length}`);

if (skillEntries.length) {
  const probe = skillEntries[0];
  const head = readEntry(probe).subarray(0, 80).toString('utf8');
  if (!head.trimStart().startsWith('---') && !head.trimStart().startsWith('#')) {
    console.error('⚠ dataBase 可能不对，内容不像 SKILL.md');
  }
}

/** 从 frontmatter 里取 name / description（支持块标量） */
function parseFront(text) {
  const lines = text.split(/\r?\n/);
  let start = -1;
  let end = -1;
  for (let i = 0; i < Math.min(lines.length, 200); i++) {
    if (lines[i].trim() === '---') {
      if (start < 0) start = i;
      else {
        end = i;
        break;
      }
    }
  }
  if (start < 0 || end < 0) return { name: null, desc: null };
  let name = null;
  let desc = null;
  for (let i = start + 1; i < end; i++) {
    const L = lines[i];
    let m = /^name:\s*(.+)$/.exec(L);
    if (m) name = m[1].trim().replace(/^["']|["']$/g, '');
    m = /^description:\s*(.*)$/.exec(L);
    if (m) {
      const rest = m[1].trim();
      if (/^[>|][+-]?$/.test(rest)) {
        const parts = [];
        for (let j = i + 1; j < end; j++) {
          if (/^\s+\S/.test(lines[j])) parts.push(lines[j].trim());
          else break;
        }
        desc = parts.join(' ');
      } else {
        desc = rest.replace(/^["']|["']$/g, '');
      }
    }
  }
  if (desc) desc = desc.replace(/\s+/g, ' ').trim();
  return { name, desc };
}

const bundled = [];
for (const e of skillEntries) {
  const dir = e.path.replace(/\/SKILL\.md$/, '');
  const text = readEntry(e).toString('utf8');
  const { name, desc } = parseFront(text);
  bundled.push({ dir, path: e.path, name, desc, bytes: e.size });
}

writeFileSync(OUT, JSON.stringify({ asar: ASAR, dataBase, count: bundled.length, skills: bundled }, null, 2), 'utf8');

console.log(`内置技能 ${bundled.length} 个；前 10 条：`);
for (const b of bundled.slice(0, 10)) {
  console.log(`  ${String(b.bytes).padStart(7)}  ${b.dir.padEnd(38)} ${(b.desc || '').slice(0, 50)}`);
}
if (bundled.length > 10) console.log(`  … 另有 ${bundled.length - 10} 个`);
console.log(`\n→ ${OUT}`);
