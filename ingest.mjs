/**
 * ingest.mjs — 双源技能摄取（实时扫描）
 *
 * 来源：
 *   A. 用户根   ~/.agents/skills/<dir>/SKILL.md        每次运行实时扫描（可写）
 *   B. 内置根   app.asar → skills|assets/<dir>/SKILL.md 由 asar-skills.mjs 预先解析（只读）
 *
 * 为什么必须实时扫描：新增 / 删除技能后，索引要立刻反映，否则「新技能自动分类」不成立。
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillsRoot } from './paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'inventory.json');
// 技能根走公共解析：尊重 AGENTS_SKILLS_DIR 与环境差异，
// 不能在这里写死 homedir()，否则自定义安装位置、CI 与测试环境都会失效。
const USER_ROOT = skillsRoot();
const BUNDLED = join(HERE, 'bundled.json');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));

/* ---------------------------- frontmatter ---------------------------- */

function parseFront(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[0].charCodeAt(0) === 0xfeff) lines[0] = lines[0].slice(1);
  let start = -1;
  let end = -1;
  for (let i = 0; i < Math.min(lines.length, 200); i++) {
    if (lines[i].trim() === '---') {
      if (start < 0) {
        if (i <= 2) start = i;
      } else {
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
        const buf = [];
        for (let j = i + 1; j < end; j++) {
          if (/^\s+\S/.test(lines[j])) buf.push(lines[j].trim());
          else break;
        }
        desc = buf.join(' ');
      } else {
        desc = rest.replace(/^["']|["']$/g, '');
      }
    }
  }
  if (desc) desc = desc.replace(/\s+/g, ' ').trim();
  return { name, desc };
}

function countFiles(dir) {
  let files = 0;
  let hasCode = false;
  const CODE = new Set(['.js', '.mjs', '.cjs', '.py', '.sh', '.ps1', '.ts']);
  const walk = (d, depth) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(join(d, e.name), depth + 1);
      else if (e.isFile()) {
        files++;
        const dot = e.name.lastIndexOf('.');
        if (dot > 0 && CODE.has(e.name.slice(dot).toLowerCase())) hasCode = true;
      }
    }
  };
  walk(dir, 0);
  return { files, hasCode };
}

/* ---------------------------- 扫描一个技能根 ---------------------------- */

/**
 * 通用根扫描。sourceId 决定优先级与统计口径：
 *   user    → 用户真实安装（~/.agents/skills）
 *   lab     → 实验样本（从 GitHub 下载、只用于验证分类器，不进用户目录）
 *   bundled → 产品内置
 */
function scanRoot(root, sourceId, sourceLabel) {
  if (!existsSync(root)) return { skills: [], backups: [], missing: true };
  const skills = [];
  const backups = [];

  for (const ent of readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith('.')) continue;
    const dir = join(root, ent.name);
    const file = join(dir, 'SKILL.md');
    if (!existsSync(file)) continue;

    // 备份目录：xxx.bak-2026-... / xxx.backup-... 不当作独立技能
    if (/\.(bak|backup)[-. ]/i.test(ent.name)) {
      backups.push(ent.name);
      continue;
    }

    const text = readFileSync(file, 'utf8');
    const { name, desc } = parseFront(text);
    const { files, hasCode } = countFiles(dir);

    skills.push({
      id: ent.name,
      name: name || ent.name,
      desc: desc || '',
      source: sourceId,
      sourceLabel,
      path: join(dir, 'SKILL.md'),
      bytes: statSync(file).size,
      files,
      hasCode,
      userInvocable: true,
      userInvocableBasis: sourceId === 'user' ? '存在于用户技能根' : '存在于实验技能根',
    });
  }
  return { skills, backups, missing: false };
}

function scanUserRoot() {
  return scanRoot(USER_ROOT, 'user', '用户安装');
}

/* ---------------------------- 主流程 ---------------------------- */

const user = scanUserRoot();

/** 实验样本根：SKILLCAT_EXTRA_ROOTS="a;b" —— 只用于验证，不写进用户目录 */
const extraRoots = (process.env.SKILLCAT_EXTRA_ROOTS || '')
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);
const labSkills = [];
for (const r of extraRoots) {
  const scanned = scanRoot(r, 'lab', '实验样本');
  labSkills.push(...scanned.skills);
}

const bundledRaw = existsSync(BUNDLED) ? readJson(BUNDLED) : { skills: [] };

/** 内置技能里有一批仅模型可见（不在本会话技能目录中） */
const MODEL_ONLY_HINT =
  /(agent-experience|cordis-composition-reference|cordis-plugin-development|editing-cordis-compositions)/;

const inventory = [...user.skills, ...labSkills];

for (const b of bundledRaw.skills) {
  const pkg = /dsh\/node_modules\/(@[^/]+\/[^/]+)\//.exec(b.path);
  const modelOnly = MODEL_ONLY_HINT.test(b.dir);
  inventory.push({
    id: b.dir,
    name: b.name || b.dir,
    desc: b.desc || '',
    source: 'bundled',
    sourceLabel: pkg ? `内置 · ${pkg[1]}` : '内置',
    path: b.path,
    bytes: b.bytes,
    files: 1,
    hasCode: false,
    userInvocable: !modelOnly,
    userInvocableBasis: modelOnly ? '推断：未出现在本会话技能目录，仅模型可见' : '存在于本会话技能目录',
  });
}

// 名称去重（同名时用户根优先，内置让位）
const seen = new Set();
const deduped = [];
const PRIORITY = { user: 0, lab: 1, bundled: 2 };
for (const s of [...inventory].sort((a, b) => (PRIORITY[a.source] ?? 9) - (PRIORITY[b.source] ?? 9))) {
  if (seen.has(s.name)) continue;
  seen.add(s.name);
  deduped.push(s);
}
deduped.sort((a, b) => a.name.localeCompare(b.name));

writeFileSync(
  OUT,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      roots: [
        { id: 'user', label: '用户安装', path: USER_ROOT, writable: true, scanned: 'live' },
        {
          id: 'bundled',
          label: '产品内置',
          path: 'app.asar → dsh/node_modules/**/skills|assets',
          writable: false,
          scanned: 'asar header',
        },
      ],
      stats: {
        total: deduped.length,
        user: deduped.filter((s) => s.source === 'user').length,
        lab: deduped.filter((s) => s.source === 'lab').length,
        bundled: deduped.filter((s) => s.source === 'bundled').length,
        userInvocable: deduped.filter((s) => s.userInvocable).length,
        modelOnly: deduped.filter((s) => !s.userInvocable).length,
        backupsExcluded: user.backups.length,
      },
      backupsExcluded: user.backups,
      skills: deduped,
    },
    null,
    2
  ),
  'utf8'
);

console.log(
  `摄取：${deduped.length} 个（用户 ${deduped.filter((s) => s.source === 'user').length} / 实验 ${deduped.filter((s) => s.source === 'lab').length} / 内置 ${
    deduped.filter((s) => s.source === 'bundled').length
  }），可见 ${deduped.filter((s) => s.userInvocable).length}，备份排除 ${user.backups.length}`
);
if (user.missing) console.log(`⚠ 用户技能根不存在：${USER_ROOT}`);
