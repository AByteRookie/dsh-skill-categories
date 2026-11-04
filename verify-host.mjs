/**
 * verify-host.mjs — 宿主半的四类故障注入（真实临时目录，不碰用户技能）
 *
 *   ok       正常增删 → 日志应为 ok
 *   failed   invalidateCache 抛错 → 日志应为 FAILED:...
 *   missing  ctx.skills 不存在 → 日志应为 SERVICE-MISSING
 *   error    删除被监听目录 → 不崩，进程存活
 *
 * 每个用例开独立子进程：index.js 的监听器与日志路径是模块级状态。
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { pluginDir } from './paths.mjs';

// 与 verify-client 同源：插件位置走 paths.mjs，尊重 DSH_HOME。
// 硬读 homedir() 会在 preflight / CI 里验到上一次装的那份。
const HOST_FILE = join(pluginDir(), 'lib', 'index.js');
if (!existsSync(HOST_FILE)) {
  console.error('找不到宿主插件：' + HOST_FILE);
  console.error('先跑 node setup.mjs（或 pack.mjs）生成插件。');
  process.exit(2);
}
console.log('\n[宿主] 加载 ' + HOST_FILE);
console.log('  sha256 ' + createHash('sha256').update(readFileSync(HOST_FILE)).digest('hex'));
const HOST = pathToFileURL(HOST_FILE).href;

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${extra ? `  → ${extra}` : ''}`);
  }
}

if (process.argv[2] === '--child') {
  const CASE = process.argv[3];
  const TMP = mkdtempSync(join(tmpdir(), 'sw-' + CASE + '-'));
  const SKILLS = join(TMP, 'skills');
  const DSH = join(TMP, 'dsh');
  mkdirSync(SKILLS, { recursive: true });
  mkdirSync(DSH, { recursive: true });
  process.env.AGENTS_SKILLS_DIR = SKILLS;
  process.env.DSH_HOME = DSH;

  const mod = await import(HOST + '?case=' + CASE + '-' + Date.now());
  let calls = 0;
  mod.apply({
    skills:
      CASE === 'missing'
        ? undefined
        : {
            invalidateCache() {
              calls++;
              if (CASE === 'failed') throw new Error('injected-invalidate-failure');
            },
            notifyChange() {},
          },
    effect() {},
  });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(300);

  if (CASE === 'error') {
    rmSync(SKILLS, { recursive: true, force: true });
  } else {
    const d = join(SKILLS, 'probe-skill');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'SKILL.md'), '---\nname: probe-skill\ndescription: probe\n---\n');
  }
  await sleep(900);

  const LOG = join(DSH, 'skill-categories-host.log');
  const log = existsSync(LOG) ? readFileSync(LOG, 'utf8') : '';
  console.log(JSON.stringify({ calls, lines: log.split(/\r?\n/).filter(Boolean) }));
  process.exit(0);
}

const run = (c) => {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', c], {
    encoding: 'utf8',
    timeout: 20000,
  });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
};

console.log('\n[宿主] watcher 与失效路径（真实临时目录）');

{
  const r = run('ok');
  const okLine = /invalidate #1\s+ok/.test(r.out);
  ok(r.status === 0 && okLine, '正常新增 → 日志 ok', okLine ? '' : r.out.slice(0, 120));
}

{
  const r = run('failed');
  const failedLine = /invalidate #1\s+FAILED:injected-invalidate-failure/.test(r.out);
  ok(failedLine, '清缓存抛错 → 日志写 FAILED 与原因', failedLine ? '' : r.out.slice(0, 160));
}

{
  const r = run('missing');
  const missingLine = /invalidate #1\s+SERVICE-MISSING/.test(r.out);
  ok(missingLine, '没有 skills 服务 → 日志 SERVICE-MISSING', missingLine ? '' : r.out.slice(0, 160));
}

{
  const r = run('error');
  ok(r.status === 0, '删除被监听目录不崩溃（进程正常退出）', 'exit=' + r.status);
}

console.log(`\n宿主结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
