/**
 * verify-all.mjs — 发行前的固定验收集
 *
 * 七组一起跑，任何一组失败即整体失败：
 *   1. 分类体系静态断言      verify-taxonomy
 *   2. 客户端功能与回归      verify-client   （含发行产物 lint + 空缓存建索引）
 *   3. 别名覆盖              verify-names
 *   4. 检索准确率            verify-query
 *   5. 宿主监听与故障注入    verify-host
 *   6. 安装器失败路径        verify-install
 *   7. 固定数据集核心行为    verify-fixture
 *
 * 用法：node verify-all.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const SUITES = [
  ['分类体系', 'verify-taxonomy.mjs'],
  ['客户端', 'verify-client.mjs'],
  ['别名', 'verify-names.mjs'],
  ['检索', 'verify-query.mjs'],
  ['宿主', 'verify-host.mjs'],
  ['安装器', 'verify-install.mjs'],
  ['固定数据集', 'verify-fixture.mjs'],
];

let failed = 0;
const summary = [];

for (const [name, file] of SUITES) {
  const r = spawnSync(process.execPath, [join(HERE, file)], { encoding: 'utf8', timeout: 180000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const skipped = /^SKIP:/m.test(out);
  const line =
    (out.match(/断言：\d+ 通过 \/ \d+ 失败/) ||
      out.match(/方案 A[^\n]*/) ||
      out.match(/结果：\d+ 通过 \/ \d+ 失败/g)?.slice(-1) ||
      out.match(/宿主结果：\d+ 通过 \/ \d+ 失败/) || [''])[0];
  const good = r.status === 0;
  if (!good) failed++;
  summary.push({ name, code: r.status, line: line.trim(), skipped });
  console.log(`  ${good ? (skipped ? '○' : '✓') : '✗'} ${name.padEnd(6)} ${skipped ? '跳过（本机数据不适用）' : line.trim()}`);
  if (!good) {
    console.log('    ── 失败输出（尾部）──');
    console.log(out.split(/\r?\n/).slice(-20).join('\n'));
  }
}

console.log('\n' + '-'.repeat(52));
for (const s of summary) {
  console.log(`  ${s.name.padEnd(6)} exit=${s.code}  ${s.skipped ? 'SKIP' : s.line}`);
}
console.log('-'.repeat(52));
console.log(failed ? `发行验收未通过：${failed} 组失败` : '发行验收全部通过');
process.exit(failed ? 1 : 0);
