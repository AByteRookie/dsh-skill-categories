/**
 * rollback.mjs — 撤销安装
 *
 * 做三件事：
 *   1. 保留历史备份，不用旧快照覆盖当前配置
 *   2. 从当前 package.json 精确摘掉本插件（依赖 + bundles）
 *   3. 删除 profile/node_modules 下的链接
 *
 * 插件源码目录保留（可再次安装）。
 *
 *   node rollback.mjs                 # 自动选 profile
 *   node rollback.mjs --profile web
 */

import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { PLUGIN_NAME, activeProfile, pluginDir } from './paths.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const profile = activeProfile(arg('--profile'));
const changes = [];

/* Preserve later installs/settings; never restore a whole historical profile. */
{
  const pkgPath = profile.pkgPath;
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8').replace(/^\uFEFF/, ''));

  if (pkg.dependencies?.[PLUGIN_NAME]) {
    delete pkg.dependencies[PLUGIN_NAME];
    changes.push(`dependencies 移除 ${PLUGIN_NAME}`);
  }
  const bundles = pkg.dsh?.profile?.bundles;
  if (Array.isArray(bundles)) {
    const i = bundles.indexOf(PLUGIN_NAME);
    if (i >= 0) {
      bundles.splice(i, 1);
      changes.push(`bundles 移除 ${PLUGIN_NAME}`);
    }
  }
  if (changes.length) writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
}

/* ---------------------------- 2. 删链接 ---------------------------- */

const link = join(profile.dir, 'node_modules', PLUGIN_NAME);
if (existsSync(link)) {
  try {
    rmSync(link, { recursive: false }); // junction / symlink：不递归
  } catch {
    rmSync(link, { recursive: true, force: true });
  }
  changes.push(`node_modules/${PLUGIN_NAME} 链接已删除`);
}

/* ---------------------------- 输出 ---------------------------- */

console.log(`profile: ${profile.name}（${profile.reason}）`);
if (changes.length) {
  console.log('已撤销：');
  for (const c of changes) console.log('  · ' + c);
} else {
  console.log('没有发现安装痕迹，无需撤销。');
}

console.log('\n插件源码保留在：' + pluginDir());
console.log('重新安装：node setup.mjs');
console.log('\n注意：回滚同样需要重启 DSH 才生效。');
