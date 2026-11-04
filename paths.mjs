/**
 * paths.mjs — 运行环境发现
 *
 * 这个文件存在的唯一理由：**仓库里不能有任何写死的机器路径**。
 * 之前那版把 D:\DSH桌面、C:\Users\Lenovo、D:\node.exe 散落在 9 个文件里，
 * 别人 clone 下来第一步就崩。现在所有路径都从这里推导。
 *
 * 发现顺序（优先级从高到低）：
 *   DSH_HOME / DSH_PROFILE / DSH_ASAR / AGENTS_SKILLS_DIR 环境变量
 *   命令行 --profile / --asar
 *   从运行中的进程反查（Windows）
 *   常见安装位置
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 仓库根目录（本文件所在目录） */
export const ROOT = dirname(fileURLToPath(import.meta.url));

/** 插件在 DSH 里的名字，install / profile 发现都用它 */
export const PLUGIN_NAME = 'dsh-skill-categories';

const BACKUP_RE = /(backup|\.bak|^node_modules$)/i;

export const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));

export function readJsonSafe(p, fallback) {
  try {
    return readJson(p);
  } catch {
    return fallback;
  }
}

/* ---------------------------- DSH 主目录 ---------------------------- */

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/* ---------------------------- profile 发现 ---------------------------- */

/**
 * 列出所有像样的 profile。
 * 排除 X-backup-时间戳、*.bak、node_modules 这些非活跃目录。
 */
export function listProfiles() {
  const dir = join(dshHome(), 'profiles');
  if (!existsSync(dir)) return [];

  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    if (BACKUP_RE.test(ent.name)) continue;

    const profileDir = join(dir, ent.name);
    const pkgPath = join(profileDir, 'package.json');
    if (!existsSync(pkgPath)) continue;

    let bundles = [];
    let mtime = 0;
    try {
      mtime = statSync(pkgPath).mtimeMs;
    } catch {}
    try {
      bundles = readJson(pkgPath).dsh?.profile?.bundles || [];
    } catch {}

    out.push({ name: ent.name, dir: profileDir, pkgPath, bundles, mtime });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/**
 * 挑一个要操作的 profile。
 *
 * 优先级：
 *   1. 显式指定（--profile / DSH_PROFILE）
 *   2. 已经装了本插件的那个（升级场景，避免改错）
 *   3. 最近修改过的（作为「用户在用哪个」的代理指标）
 *
 * 第 3 条是启发式，不是事实：DSH 没有公开「当前 profile」的标记文件。
 * 猜错时用户可以用 --profile 覆盖，doctor.mjs 会把候选列出来。
 */
export function activeProfile(explicit) {
  const profiles = listProfiles();
  const pick = (name) => {
    const p = profiles.find((x) => x.name === name);
    if (!p) {
      throw new Error(
        `profile "${name}" 不存在。可选：${profiles.map((x) => x.name).join(', ') || '（无）'}`
      );
    }
    return { ...p, reason: explicit ? '--profile 指定' : 'DSH_PROFILE 环境变量' };
  };

  if (explicit) return pick(explicit);
  if (process.env.DSH_PROFILE) return pick(process.env.DSH_PROFILE);

  const installed = profiles.filter((p) => p.bundles.includes(PLUGIN_NAME));
  if (installed.length === 1) return { ...installed[0], reason: '已装本插件的 profile' };
  if (installed.length > 1) return { ...installed[0], reason: '已装本插件（多个，取最近修改）' };

  if (profiles.length) return { ...profiles[0], reason: '最近修改过的 profile' };

  throw new Error(`在 ${join(dshHome(), 'profiles')} 下没有找到任何 profile —— DSH 装过并至少启动过一次吗？`);
}

/* ---------------------------- app.asar 发现 ---------------------------- */

/** 从运行中的进程反查可执行文件路径（Windows） */
function windowsExePath() {
  if (process.platform !== 'win32') return null;
  try {
    // 必须先把 PowerShell 的输出编码设成 UTF-8：
    // 默认走控制台代码页（中文系统是 GBK），Node 按 utf8 解码会得到乱码路径，
    // 结果 join 出来的 app.asar 永远不存在。
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' +
          "(Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -First 1).Path",
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 }
    )
      .replace(/^\uFEFF/, '')
      .trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * 找 DSH 的 app.asar（内置技能的来源）。
 * 找不到时返回 null，由调用方给出可操作的提示。
 */
export function findAsar(explicit) {
  if (explicit) return existsSync(explicit) ? explicit : null;
  if (process.env.DSH_ASAR) return existsSync(process.env.DSH_ASAR) ? process.env.DSH_ASAR : null;

  const exe = windowsExePath();
  if (exe) {
    const p = join(dirname(exe), 'resources', 'app.asar');
    if (existsSync(p)) return p;
  }

  const guesses = [
    '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar',
    join(homedir(), 'Applications', 'DeepSeek Harness.app', 'Contents', 'Resources', 'app.asar'),
    '/opt/DeepSeek Harness/resources/app.asar',
  ];
  for (const g of guesses) if (existsSync(g)) return g;
  return null;
}

/* ---------------------------- 其余位置 ---------------------------- */

/** 用户自装技能根 */
export function skillsRoot() {
  return process.env.AGENTS_SKILLS_DIR || join(homedir(), '.agents', 'skills');
}

/** 插件安装位置（install 写、DSH 读） */
export function pluginDir() {
  return join(dshHome(), 'local-plugins', PLUGIN_NAME);
}

/** Node 可执行文件 —— 用当前进程，绝不写死 D:\node.exe */
export function nodeExe() {
  return process.execPath;
}

/** 一次性把环境打印出来，setup / doctor 共用 */
export function describeEnv() {
  return {
    node: process.version,
    nodeExe: nodeExe(),
    platform: `${process.platform} ${process.arch}`,
    dshHome: dshHome(),
    skillsRoot: skillsRoot(),
    pluginDir: pluginDir(),
    asar: findAsar(),
    profiles: listProfiles().map((p) => ({
      name: p.name,
      hasPlugin: p.bundles.includes(PLUGIN_NAME),
      bundles: p.bundles.length,
    })),
  };
}
