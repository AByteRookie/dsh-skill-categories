/**
 * install.mjs — 把 dsh-skill-categories 挂进 DSH 的 profile
 *
 * 做两件事（幂等）：
 *   1. package.json：加 file: 依赖 + 追加到 dsh.profile.bundles
 *   2. 校验 node_modules 里能解析到这个包
 *
 * 故意**不碰** cordis.patch.yml：
 *   装配行由插件包内的 cordis.patch.yml 负责（package.json 的 dsh.bundle.patch 指向它）。
 *   profile 层再 insert 一次会让同一个 id 注册两遍，轻则重复、重则启动失败 —— 踩过两次。
 *
 * 用法：
 *   node install.mjs                  # 自动选 profile
 *   node install.mjs --profile web    # 指定
 */

import { readFileSync, writeFileSync, existsSync, lstatSync, symlinkSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { PLUGIN_NAME, activeProfile, pluginDir } from './paths.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const profile = activeProfile(arg('--profile'));
const PKG_PATH = profile.pkgPath;
const PLUGIN_DIR = pluginDir().replace(/\\/g, '/');
const DEP_SPEC = `file:${PLUGIN_DIR}`;

const changes = [];
const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8').replace(/^\uFEFF/, ''));

/* ---------------------------- node_modules 链接 ---------------------------- */

/**
 * DSH 用 Node 的模块解析找 bundle，所以 profile/node_modules 下必须有这个包。
 * 这里建目录联接（Windows）/ 符号链接（POSIX）指向 local-plugins 里的真实目录，
 * 这样每次重新生成插件内容就自动生效，不用重新拷贝。
 *
 * 顺序很重要：链接在改 package.json 之前做。
 * 链接失败就立刻中止，profile 保持原样 —— 否则会留下「bundles 加了但装不上」的半成品。
 */
function ensureLink() {
  const linkPath = join(profile.dir, 'node_modules', PLUGIN_NAME);
  const target = pluginDir();
  if (!existsSync(join(target, 'lib', 'client.js')) || !existsSync(join(target, 'lib', 'index.js'))) {
    return { ok: false, reason: '插件目录尚未生成（先跑 pack.mjs）' };
  }

  let isLink = false;
  try {
    isLink = lstatSync(linkPath).isSymbolicLink();
  } catch {}

  if (existsSync(linkPath) && !isLink) {
    // 之前是拷贝的实体目录：内容可能过期，删掉重建
    try {
      rmSync(linkPath, { recursive: true, force: true });
      changes.push(`node_modules/${PLUGIN_NAME} 实体目录 → 重建为链接`);
    } catch (e) {
      return { ok: false, reason: `无法移除已存在的实体目录（${e.code || e.message}）` };
    }
  }

  if (!existsSync(linkPath)) {
    try {
      // 新建的 profile 可能根本没有 node_modules 目录，先补出来
      mkdirSync(join(profile.dir, 'node_modules'), { recursive: true });
      symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      changes.push(`node_modules/${PLUGIN_NAME} 建立链接`);
    } catch (e) {
      return { ok: false, reason: `链接失败（${e.code || e.message}），可能需要管理员权限` };
    }
  }

  // 链接建好不代表能解析：确认它确实指向我们的插件目录
  try {
    const real = realpathSync(linkPath);
    const want = realpathSync(target);
    if (real !== want) return { ok: false, reason: `链接指向了别处：${real}` };
  } catch (e) {
    return { ok: false, reason: `链接无法解析（${e.code || e.message}）` };
  }

  return { ok: true };
}

const link = ensureLink();
if (!link.ok) {
  console.error(`\n安装失败：${link.reason}`);
  console.error('profile 未被修改。修复后重试，或用 node install.mjs --profile <name> 指定 profile。');
  process.exit(1);
}

/* ---------------------------- package.json ---------------------------- */

pkg.dependencies = pkg.dependencies || {};
if (pkg.dependencies[PLUGIN_NAME] !== DEP_SPEC) {
  pkg.dependencies[PLUGIN_NAME] = DEP_SPEC;
  changes.push(`dependencies += ${PLUGIN_NAME}: ${DEP_SPEC}`);
}

pkg.dsh = pkg.dsh || {};
pkg.dsh.profile = pkg.dsh.profile || {};
const bundles = (pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || []);
if (!bundles.includes(PLUGIN_NAME)) {
  bundles.push(PLUGIN_NAME); // 放末尾：客户端插件顺序不敏感，但保持其余插件的相对次序
  changes.push(`dsh.profile.bundles += ${PLUGIN_NAME}`);
}

pkg.dependencies = Object.fromEntries(
  Object.entries(pkg.dependencies).sort(([a], [b]) => a.localeCompare(b))
);

if (changes.length) writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

/* ---------------------------- 输出 ---------------------------- */

console.log(`profile: ${profile.name}（${profile.reason}）`);
console.log(changes.length ? '已修改：' : '无需修改（已是目标状态）：');
for (const c of changes) console.log('  · ' + c);

const after = JSON.parse(readFileSync(PKG_PATH, 'utf8').replace(/^\uFEFF/, ''));

// 每一条都要真的验，不能只验前置步骤的退出码。
// 复测报过：链接失败曾经照样退出 0，调用方以为装好了。
const checks = {
  '插件文件存在': existsSync(join(pluginDir(), 'lib', 'client.js')) && existsSync(join(pluginDir(), 'lib', 'index.js')),
  'node_modules 链接可解析': link.ok,
  '在 bundles 中': Array.isArray(after.dsh?.profile?.bundles) && after.dsh.profile.bundles.includes(PLUGIN_NAME),
  '在 dependencies 中': after.dependencies?.[PLUGIN_NAME] === DEP_SPEC,
};

console.log('\n校验：');
let allOk = true;
for (const [label, ok] of Object.entries(checks)) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) allOk = false;
}

if (!allOk) {
  console.error('\n安装未完成：上面有未通过的项。profile 可能已被部分修改，请修复后重跑本脚本。');
  process.exit(1);
}

console.log('\n下一步：重启 DSH 让宿主加载插件（Windows 可用 restart-dsh.bat）。');
console.log('之后只改客户端代码的话，Ctrl+R 重载渲染进程即可。');
