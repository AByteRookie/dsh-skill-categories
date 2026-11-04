/**
 * preflight.mjs — 推送前跑一遍「CI 会怎么跑」，避免把红提交推上去
 *
 * 与 .github/workflows/verify.yml 的 acceptance job 等价：
 *   1. 造一个没有 profile 的空 DSH_HOME（模拟 CI runner）
 *   2. setup.mjs --skip-asar --no-install（CI 的第一条命令）
 *   3. verify-all.mjs（六组检查）
 *
 * 用法：node preflight.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'preflight-'));
const env = { ...process.env, DSH_HOME: home };
delete env.DSH_ASAR;

const step = (label, args) => {
  process.stdout.write(`\n▸ ${label}\n`);
  const r = spawnSync(process.execPath, args, { cwd: HERE, env, encoding: 'utf8', timeout: 300000 });
  const out = ((r.stdout || '') + (r.stderr || '')).split(/\r?\n/).filter(Boolean);
  console.log(out.slice(-12).map((l) => '  ' + l).join('\n'));
  return r.status;
};

let code = step('生成（无 profile，等同 CI）', ['setup.mjs', '--skip-asar', '--no-install']);
if (code !== 0) {
  console.error('\npreflight 失败：setup 在无 profile 环境下不能跑完');
  rmSync(home, { recursive: true, force: true });
  process.exit(1);
}

code = step('验收（六组）', ['verify-all.mjs']);
rmSync(home, { recursive: true, force: true });

if (code !== 0) {
  console.error('\npreflight 失败：验收没过，不要推送');
  process.exit(1);
}
console.log('\npreflight 通过：这次推送在 CI 上应当全绿');
