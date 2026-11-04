/**
 * verify-install.mjs — 安装器失败路径：必须非零退出且不改 profile
 *
 * 复测报过的问题：链接失败时 install.mjs 仍退出 0，
 * 上层 setup / PowerShell 于是提示「安装成功」。
 *
 * 这里验两件事：
 *   1. 插件目录不存在 → 退出码 1，profile 原样
 *   2. 链接路径被占（悬空链接）→ 退出码 1，profile 原样（Windows 可建 junction 时）
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = mkdtempSync(join(tmpdir(), 'inst-'));

let pass = 0;
let fail = 0;
const ok = (cond, label, extra) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${extra ? `  → ${extra}` : ''}`);
  }
};

function makeProfile(tag) {
  const home = join(BASE, tag);
  const prof = join(home, 'profiles', 'desktop');
  mkdirSync(join(prof, 'node_modules'), { recursive: true });
  const pkg = { name: 'p', private: true, dependencies: {}, dsh: { profile: { bundles: ['dsh-base'] } } };
  writeFileSync(join(prof, 'package.json'), JSON.stringify(pkg, null, 2));
  return { home, prof, pkgPath: join(prof, 'package.json') };
}

const runInstall = (home) => {
  const r = spawnSync(process.execPath, [join(HERE, 'install.mjs'), '--profile', 'desktop'], {
    cwd: HERE,
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
    timeout: 60000,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};

console.log('\n[安装器] 失败路径必须中止，且不动 profile');

// 1) 插件不存在
{
  const p = makeProfile('no-plugin');
  const r = runInstall(p.home);
  const before = readFileSync(p.pkgPath, 'utf8');
  const untouched = JSON.stringify(JSON.parse(before).dsh.profile.bundles) === JSON.stringify(['dsh-base']);
  ok(r.code !== 0, '插件缺失时返回非零退出码', 'exit=' + r.code);
  ok(untouched, '插件缺失时 profile 未被修改');
}

// 2) 悬空链接占住路径
{
  const p = makeProfile('broken-link');
  const link = join(p.prof, 'node_modules', 'dsh-skill-categories');
  let created = false;
  try {
    symlinkSync(join(BASE, 'no-such-target'), link, 'junction');
    created = true;
  } catch {
    try {
      symlinkSync(join(BASE, 'no-such-target'), link, 'dir');
      created = true;
    } catch {
      /* 没有建链接权限 */
    }
  }

  if (!created) {
    console.log('  ○ 跳过：本机无法创建链接（需要开发者模式或管理员权限）');
  } else {
    // 先把插件造出来，确保失败点落在链接而不是「插件缺失」
    spawnSync(process.execPath, [join(HERE, 'pack.mjs')], {
      cwd: HERE,
      env: { ...process.env, DSH_HOME: p.home },
      encoding: 'utf8',
      timeout: 120000,
    });
    let isLink = false;
    try {
      isLink = lstatSync(link).isSymbolicLink();
    } catch {}

    const r = runInstall(p.home);
    const after = JSON.parse(readFileSync(p.pkgPath, 'utf8'));
    const untouched = JSON.stringify(after.dsh.profile.bundles) === JSON.stringify(['dsh-base']);
    ok(isLink, '悬空链接已建立（测试前置）');
    ok(r.code !== 0, '链接失败时返回非零退出码', 'exit=' + r.code);
    ok(untouched, '链接失败时 profile 未被修改');
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
