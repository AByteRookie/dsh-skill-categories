#!/usr/bin/env node
/**
 * doctor.mjs — 环境诊断
 *
 * 装不上 / 插件没生效时先跑这个。它只读不写。
 *
 *   node doctor.mjs
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, PLUGIN_NAME, describeEnv, findAsar, listProfiles, pluginDir, skillsRoot } from './paths.mjs';

const ok = (s) => `\x1b[32m✓\x1b[0m ${s}`;
const no = (s) => `\x1b[31m✗\x1b[0m ${s}`;
const warn = (s) => `\x1b[33m!\x1b[0m ${s}`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const env = describeEnv();
const issues = [];

console.log('\n\x1b[1mDSH Skill Categories — doctor\x1b[0m\n');

/* ---------------------------- 运行时 ---------------------------- */

console.log('\x1b[1m运行时\x1b[0m');
console.log('  ' + ok(`node ${env.node}`));
console.log('  ' + ok(env.platform));
console.log('  ' + dim(env.nodeExe));

/* ---------------------------- 技能来源 ---------------------------- */

console.log('\n\x1b[1m技能来源\x1b[0m');

const sr = skillsRoot();
let userSkillCount = 0;
let backupCount = 0;
if (existsSync(sr)) {
  for (const e of readdirSync(sr, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (!existsSync(join(sr, e.name, 'SKILL.md'))) continue;
    // 与 ingest.mjs 保持同一口径：备份目录不算技能
    if (/\.(bak|backup)[-. ]/i.test(e.name)) backupCount++;
    else userSkillCount++;
  }
  console.log('  ' + ok(`用户技能根 ${userSkillCount} 个`) + dim('  ' + sr));
  if (backupCount) console.log('  ' + dim(`  另有 ${backupCount} 个备份目录已排除`));
  if (userSkillCount === 0) issues.push('用户技能根为空，菜单只会有内置技能');
} else {
  console.log('  ' + warn('用户技能根不存在') + dim('  ' + sr));
  issues.push('没有 ~/.agents/skills —— 你可能还没装过任何技能');
}

const asar = findAsar();
if (asar) {
  const mb = (statSync(asar).size / 1024 / 1024).toFixed(1);
  console.log('  ' + ok(`app.asar ${mb} MB`) + dim('  ' + asar));
} else {
  console.log('  ' + no('找不到 app.asar'));
  issues.push('找不到 app.asar：内置技能会缺失。启动一次 DSH 后重试，或用 DSH_ASAR 指定');
}

const bundledJson = join(ROOT, 'bundled.json');
if (existsSync(bundledJson)) {
  try {
    const b = JSON.parse(readFileSync(bundledJson, 'utf8').replace(/^\uFEFF/, ''));
    console.log('  ' + ok(`bundled.json ${b.count} 个内置技能`) + dim('  （可能已过期，重跑 setup 刷新）'));
  } catch {}
} else {
  console.log('  ' + dim('bundled.json 尚未生成'));
}

/* ---------------------------- profile ---------------------------- */

console.log('\n\x1b[1mProfile\x1b[0m');
const profiles = listProfiles();
if (!profiles.length) {
  console.log('  ' + no('没有找到任何 profile'));
  issues.push('DSH 至少启动成功过一次吗？');
} else {
  for (const p of profiles) {
    const has = p.bundles.includes(PLUGIN_NAME);
    const when = new Date(p.mtime).toISOString().slice(0, 16).replace('T', ' ');
    console.log(
      `  ${has ? ok('已装') : dim('未装')}  ${p.name.padEnd(12)} ${dim(when)}  ${dim(p.bundles.length + ' bundles')}`
    );
  }
}

/* ---------------------------- 插件本体 ---------------------------- */

console.log('\n\x1b[1m插件\x1b[0m');
const dir = pluginDir();
const client = join(dir, 'lib', 'client.js');
const host = join(dir, 'lib', 'index.js');
if (existsSync(client)) {
  const kb = (statSync(client).size / 1024).toFixed(1);
  console.log('  ' + ok(`client.js ${kb} KB`) + dim('  ' + dir));
} else {
  console.log('  ' + no('client.js 不存在') + dim('  ' + dir));
  issues.push('插件还没生成：先跑 node setup.mjs');
}
if (existsSync(host)) console.log('  ' + ok('index.js（宿主半）'));

// node_modules 链接
for (const p of profiles) {
  const link = join(p.dir, 'node_modules', PLUGIN_NAME);
  if (p.bundles.includes(PLUGIN_NAME)) {
    console.log(
      '  ' + (existsSync(link) ? ok('node_modules 链接正常') : no('node_modules 缺失')) + dim('  ' + p.name)
    );
    if (!existsSync(link)) issues.push(`profile ${p.name} 指向的插件在 node_modules 里找不到`);
  }
}

/* ---------------------------- 索引 ---------------------------- */

console.log('\n\x1b[1m索引\x1b[0m');
const idxPath = join(ROOT, 'index.json');
if (existsSync(idxPath)) {
  try {
    const idx = JSON.parse(readFileSync(idxPath, 'utf8').replace(/^\uFEFF/, ''));
    const vis = idx.skills.filter((s) => s.userInvocable);
    const cats = new Set(vis.map((s) => s.category));
    console.log('  ' + ok(`${idx.skills.length} 个技能 / 可见 ${vis.length} / ${cats.size} 类`));
    const misc = vis.filter((s) => s.category === 'misc');
    console.log(
      '  ' + (misc.length ? warn(`未归类 ${misc.length} 个`) : ok('没有未归类'))
    );

    // 漂移检测：索引是快照，装了新技能后不重跑 setup 就会过期，
    // 表现是菜单里少了一批技能，而且不会报错。
    const drift = userSkillCount - vis.filter((s) => s.source === 'user').length;
    if (drift > 0) {
      console.log('  ' + warn(`索引比技能库少 ${drift} 个 → 跑一次 node setup.mjs`));
      issues.push(`索引过期：技能库多出 ${drift} 个技能未进索引`);
    } else if (drift < 0) {
      console.log('  ' + warn(`索引比技能库多 ${-drift} 个（可能删过技能）→ 重跑 setup`));
    }
  } catch (e) {
    console.log('  ' + no('index.json 解析失败'));
  }
} else {
  console.log('  ' + dim('尚未生成'));
}

/* ---------------------------- 结论 ---------------------------- */

console.log('\n\x1b[1m结论\x1b[0m');
if (!issues.length) {
  console.log('  ' + ok('环境看起来没问题。若菜单没变化，重启 DSH（宿主插件只在启动时加载）。'));
} else {
  issues.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
}
console.log('');
