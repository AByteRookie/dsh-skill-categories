#!/usr/bin/env node
/**
 * setup.mjs — 一条命令装好
 *
 *   node setup.mjs                # 自动发现环境，生成并安装
 *   node setup.mjs --dry-run      # 只检查环境，什么都不写
 *   node setup.mjs --profile web  # 指定 profile
 *   node setup.mjs --asar <path>  # 指定 app.asar
 *   node setup.mjs --no-install   # 只生成，不挂进 profile
 *
 * 流程（顺序不能换）：
 *   asar-skills → ingest → aliases → build → pack → install
 *
 * 为什么这个顺序：aliases 读 inventory（ingest 的产物），build 读 aliases，
 * pack 读 index。早先写成 ingest → aliases → build 才对；
 * 曾经因为 aliases 读 index（build 的产物）形成循环，新技能拿不到入口词。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, PLUGIN_NAME, nodeExe, describeEnv, findAsar, activeProfile, skillsRoot, pluginDir } from './paths.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

const DRY = has('--dry-run');
const SKIP_ASAR = has('--skip-asar');
const NO_INSTALL = has('--no-install');

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

/* ---------------------------- 环境检查 ---------------------------- */

console.log(c.bold('\nDSH Skill Categories — setup\n'));

const env = describeEnv();
const asar = findAsar(val('--asar'));

console.log('环境');
console.log(`  node        ${env.node}  (${env.nodeExe})`);
console.log(`  系统        ${env.platform}`);
console.log(`  DSH 目录    ${env.dshHome}`);
console.log(`  技能根      ${env.skillsRoot}`);
console.log(`  app.asar    ${asar || c.yellow('未找到')}`);

let profile = null;
try {
  profile = activeProfile(val('--profile'));
  console.log(`  profile     ${profile.name}  ${c.dim('(' + profile.reason + ')')}`);
} catch (e) {
  console.log(`  profile     ${c.red('不可用')} —— ${e.message}`);
}

const skillsDir = skillsRoot();
// 与 ingest 同口径：备份目录（xxx.bak-时间戳）不算技能
const skillCount = existsSync(skillsDir)
  ? readdirSync(skillsDir, { withFileTypes: true }).filter(
      (e) =>
        e.isDirectory() &&
        !/\.(bak|backup)[-. ]/i.test(e.name) &&
        existsSync(join(skillsDir, e.name, 'SKILL.md'))
    ).length
  : 0;
console.log(`  用户技能    ${existsSync(skillsDir) ? skillCount + ' 个' : c.red('目录不存在')}`);

/* ---------------------------- 前置条件 ---------------------------- */

const problems = [];
if (!profile) problems.push('找不到可用的 profile（DSH 至少启动过一次吗？）');
if (!existsSync(skillsDir) && !asar) problems.push('既没有用户技能目录，也没有 app.asar —— 没有技能可以索引');
if (!asar) problems.push('找不到 app.asar：内置技能会被漏掉。可先启动 DSH 或用 --asar 指定');

if (problems.length) {
  console.log('');
  for (const p of problems) console.log(c.yellow('  ⚠ ' + p));
}

if (DRY) {
  console.log(c.bold('\n干跑结束') + c.dim('（未写入任何文件）'));
  console.log('\n将执行：');
  console.log('  node asar-skills.mjs' + (SKIP_ASAR ? c.dim('  (跳过)') : ''));
  console.log('  node ingest.mjs');
  console.log('  node aliases.mjs');
  console.log('  node build.mjs');
  console.log('  node pack.mjs');
  console.log('  node install.mjs' + (NO_INSTALL ? c.dim('  (跳过)') : ''));
  process.exit(problems.some((p) => p.includes('profile')) ? 1 : 0);
}

if (!profile) {
  console.log(c.red('\n无法继续：没有可用 profile。'));
  process.exit(1);
}

/* ---------------------------- 执行 ---------------------------- */

const steps = [];
if (!SKIP_ASAR && asar) steps.push({ name: '解析内置技能', script: 'asar-skills.mjs', argv: ['--asar', asar] });
steps.push({ name: '扫描技能库', script: 'ingest.mjs' });
steps.push({ name: '生成入口词', script: 'aliases.mjs' });
steps.push({ name: '分类并建索引', script: 'build.mjs' });
steps.push({ name: '生成客户端插件', script: 'pack.mjs' });
if (!NO_INSTALL) steps.push({ name: '挂进 profile', script: 'install.mjs', argv: ['--profile', profile.name] });

const results = [];
for (const s of steps) {
  const t0 = Date.now();
  process.stdout.write(`\n${c.bold('▸ ' + s.name)} ${c.dim(s.script)}\n`);
  try {
    execFileSync(nodeExe(), [join(ROOT, s.script), ...(s.argv || [])], {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env,
    });
    results.push({ ...s, ok: true, ms: Date.now() - t0 });
  } catch (e) {
    results.push({ ...s, ok: false, ms: Date.now() - t0, code: e.status });
    console.log(c.red(`\n✗ ${s.name} 失败（退出码 ${e.status}）`));
    break;
  }
}

/* ---------------------------- 汇总 ---------------------------- */

console.log(c.bold('\n———— 结果 ————'));
for (const r of results) {
  console.log(`  ${r.ok ? c.green('✓') : c.red('✗')} ${r.name.padEnd(14)} ${c.dim(r.ms + 'ms')}`);
}

try {
  const idx = JSON.parse(readFileSync(join(ROOT, 'index.json'), 'utf8').replace(/^\uFEFF/, ''));
  const visible = idx.skills.filter((s) => s.userInvocable);
  const cats = new Set(visible.map((s) => s.category));
  console.log('');
  console.log(`  索引技能   ${idx.skills.length}（菜单可见 ${visible.length}）`);
  console.log(`  展示类     ${cats.size}`);
  const dist = {};
  for (const s of visible) dist[s.category] = (dist[s.category] || 0) + 1;
  console.log('  分布       ' + Object.entries(dist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · '));
} catch {}

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log(c.red('\n有步骤失败，插件可能不完整。'));
  process.exit(1);
}

console.log('\n下一步');
console.log('  · 重启 DSH（宿主插件只在启动时加载）');
console.log('  · 之后只改客户端的话，Ctrl+R 重载渲染进程即可');
console.log('  · 想撤销：node rollback.mjs --profile ' + profile.name);
console.log('');
