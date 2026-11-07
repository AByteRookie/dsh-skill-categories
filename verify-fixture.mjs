/**
 * verify-fixture.mjs — 用仓库自带的固定技能库验证核心行为
 *
 * 为什么需要：verify-client / verify-names / verify-query 的断言建立在
 * 作者本人的技能库上（148 个技能），陌生人跑只能 SKIP，CI 等于没验核心。
 *
 * 这里改成：用 fixtures/skills（16 个固定技能）现场生成一份索引，
 * 再加载这次生成的 bundle，验证「分组 / 计数 / 中文检索 / 同族聚合 / 空目录」。
 * 全程数据驱动，不写死任何数字。
 *
 * 副作用：会临时覆盖仓库根的 index.json / inventory.json / aliases.json，
 * 结束时按原字节还原。
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';


const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'skills');
const GENERATED = ['index.json', 'inventory.json', 'aliases.json', 'curated.json'];

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

if (!existsSync(FIXTURES)) {
  console.error('缺少 fixtures/skills，无法运行固定数据集验收');
  process.exit(2);
}

// 备份仓库根生成物，结束后还原
const backup = new Map();
for (const f of GENERATED) {
  const p = join(HERE, f);
  backup.set(f, existsSync(p) ? readFileSync(p) : null);
}

const home = mkdtempSync(join(tmpdir(), 'fixture-'));
const env = { ...process.env, DSH_HOME: home, AGENTS_SKILLS_DIR: FIXTURES };
delete env.DSH_ASAR;

const run = (script, args) => {
  const r = spawnSync(process.execPath, [script, ...(args || [])], { cwd: HERE, env, encoding: 'utf8', timeout: 180000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};

const restore = () => {
  for (const [f, buf] of backup) {
    const p = join(HERE, f);
    if (buf === null) {
      try {
        rmSync(p, { force: true });
      } catch {
        /* ignore */
      }
    } else {
      writeFileSync(p, buf);
    }
  }
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
};

try {
  console.log('\n[固定数据集] 用 fixtures/skills 生成索引');

  // 走正式安装入口，不自己拼步骤：
  // 原先写成 ingest → build → aliases → pack，而 setup 是 ingest → aliases → build → pack。
  // 顺序反了，build 会拿到上一轮的别名表，等于测了一条生产上不存在的路径。
  const setup = run('setup.mjs', ['--skip-asar', '--no-install']);
  if (setup.code !== 0) {
    ok(false, 'setup.mjs 生成失败', setup.out.split(/\r?\n/).slice(-4).join(' | '));
    throw new Error('setup.mjs');
  }

  const idx = JSON.parse(readFileSync(join(HERE, 'index.json'), 'utf8'));
  const visible = idx.skills.filter((s) => s.userInvocable);
  console.log(`  索引 ${idx.skills.length} 条 / 可见 ${visible.length}`);

  // 必须用临时 home 推路径：本进程没有设 DSH_HOME，pluginDir() 会指向真实安装，
  // 那样就会拿「上一次装的那份」来断言，等于自欺。
  const clientFile = join(home, 'local-plugins', 'dsh-skill-categories', 'lib', 'client.js');
  ok(existsSync(clientFile), '本次生成的 bundle 存在', clientFile);
  console.log('  bundle sha256 ' + createHash('sha256').update(readFileSync(clientFile)).digest('hex'));

  /* ---------- 在仿真宿主里跑真实 bundle ---------- */

  const store = new Map();
  const win = {
    __ModuleLoader__: { load: (c) => (captured = c) },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    document: { createElement: () => ({ dataset: {}, style: {}, setAttribute() {}, appendChild() {} }), querySelector: () => null, head: { appendChild() {} } },
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
    console,
    Date,
    JSON,
    Math,
    Float32Array,
    Uint8Array,
    String,
    Number,
    Object,
    Array,
    Error,
    Promise,
    RegExp,
    isNaN,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  };
  let captured = null;
  new Function('window', 'globalThis', readFileSync(clientFile, 'utf8'))(win, win);
  const api = captured.factory(() => {
    throw new Error('no require');
  });

  // 假宿主：模拟真实 rankByName（只按名字过滤），中文查询会得到空
  let catalog = visible.map((s) => ({ name: s.name, description: s.desc }));
  const src = {
    trigger: '/',
    name: 'skill',
    order: 2,
    async candidates(session, req) {
      const q = String((req && req.query) || '').trim().toLowerCase().replace(/\s+/g, '');
      if (!q) return catalog;
      return catalog.filter((s) => s.name.toLowerCase().indexOf(q) >= 0);
    },
    onPick: () => ({ text: '/' }),
  };
  const svc = { live: { sources: [src] } };
  const originalCandidates = src.candidates;
  const originalPick = src.onPick;
  api.apply({ get: (n) => (n === 'inputTriggers' ? svc : undefined), inject: (d, cb) => cb({ get: () => svc }), effect: (f) => f() });

  // 浏览路径绝对不允许启动模型加载：那是每次启动首次按 / 卡几秒的根因。
  {
    api.diagnostics.cancelWarm();
    const startedBefore = api.diagnostics.warmStarted || 0;
    const scheduledBefore = api.diagnostics.warmScheduled || 0;
    await src.candidates({ sessionId: 'NOWARM' }, { query: '', signal: {} });
    ok((api.diagnostics.warmStarted || 0) === startedBefore, '浏览不启动模型加载（只排后台预热）');
    ok((api.diagnostics.warmScheduled || 0) > scheduledBefore, '后台预热已被排期');
    api.diagnostics.cancelWarm();
  }
  /* ---------- 通用生命周期（不依赖个人技能库） ---------- */

  // 资源释放：dispose 后必须把宿主函数原样还回去
  ok(typeof api.dispose === 'function', 'exports.dispose 存在');
  api.dispose();
  ok(src.candidates === originalCandidates, 'dispose 后 candidates 还原为原函数');
  ok(src.onPick === originalPick, 'dispose 后 onPick 还原为原函数');
  ok(src.__skillCategories === undefined, 'dispose 后包装标记已移除');
  const afterDispose = await src.candidates({ sessionId: 'FX0' }, { query: '', signal: {} });
  ok(afterDispose.every((i) => i.section === undefined), 'dispose 后不再注入 section');

  // 重新挂回去，后面的断言继续用
  api.apply({ get: (n) => (n === 'inputTriggers' ? svc : undefined), inject: (d, cb) => cb({ get: () => svc }), effect: (f) => f() });

  // 子代理会话：返回空候选，且必须是 Promise（宿主直接 .then）
  {
    const subSrc = {
      trigger: '/',
      name: 'skill',
      order: 2,
      async candidates() {
        return [{ name: 'never-shown', description: 'x' }];
      },
      onPick: () => ({ text: '/' }),
    };
    const subSvc = { live: { sources: [subSrc] } };
    const subSessions = {
      using: async (id, o, fn) => fn({ binding: { session: { getSnapshot: () => ({ openState: 'open' }) } } }),
      subagentAddress: () => ({ agent: 'child' }),
    };
    api.apply({
      get: (n) => (n === 'inputTriggers' ? subSvc : n === 'sessions' ? subSessions : undefined),
      inject: (d, cb) => cb({ get: (n) => (n === 'inputTriggers' ? subSvc : n === 'sessions' ? subSessions : undefined) }),
      effect: (f) => f(),
    });
    const r = subSrc.candidates({ sessionId: 'SUB' }, { query: '', signal: {} });
    ok(typeof r.then === 'function', 'subagent 分支返回 Promise');
    const v = await r;
    ok(Array.isArray(v) && v.length === 0, 'subagent 会话返回空候选', String(v && v.length));
    api.dispose();
    api.apply({ get: (n) => (n === 'inputTriggers' ? svc : undefined), inject: (d, cb) => cb({ get: () => svc }), effect: (f) => f() });
  }

  // 语义索引：过期任务的初始化失败不得改写当前状态
  {
    const rejecters = [];
    api.diagnostics.setSemHooks({
      importLib: () => new Promise((res, rej) => rejecters.push(rej)),
    });
    await src.candidates({ sessionId: 'SEM1' }, { query: '', signal: {} });
    await new Promise((r) => setTimeout(r, 40));
    api.diagnostics.setSemHooks({ importLib: () => new Promise((res, rej) => rejecters.push(rej)) });
    // 更换测试 provider 并更新目录，使旧初始化任务过期
    catalog = visible
      .filter((s) => s.name !== 'log-triage')
      .map((s) => ({ name: s.name, description: s.desc }));
    await src.candidates({ sessionId: 'SEM2' }, { query: '', signal: {} });
    await new Promise((r) => setTimeout(r, 40));

    // 前置条件必须显式断言：至少两个待决任务（旧的 + 新的）。
    // 否则哪天调度变了，故障根本没注入，这条用例会「什么都没测也绿」。
    ok(rejecters.length >= 2, '存在至少两个待决索引任务（故障注入前置）', `待决 ${rejecters.length} 个`);

    if (rejecters.length >= 2) {
      rejecters[0](new Error('stale init failed'));
      await new Promise((r) => setTimeout(r, 60));
      const st = api.diagnostics.semanticStatus();
      ok(st.status !== 'unavailable', '过期任务失败不把索引状态改成 unavailable', String(st.status));
      ok(st.error !== 'stale init failed', '过期任务的错误不写入当前 error', String(st.error));
    }
    for (let i = 1; i < rejecters.length; i++) rejecters[i](new Error('cleanup'));
    await new Promise((r) => setTimeout(r, 30));
    api.diagnostics.setSemHooks(null);
    catalog = visible.map((s) => ({ name: s.name, description: s.desc }));
  }

  /* ---------- 断言 ---------- */

  const items = await src.candidates({ sessionId: 'FX' }, { query: '', signal: {} });
  ok(items.length === visible.length, '浏览返回全部可见技能', `${items.length} vs ${visible.length}`);

  const sections = new Map();
  for (const it of items) {
    const k = it.section;
    if (k === undefined) continue;
    if (!sections.has(k)) sections.set(k, []);
    sections.get(k).push(it.name);
  }
  ok(sections.size >= 2, '至少分成两个组', String(sections.size));

  const header = src.header({ sessionId: 'FX' }, { query: '', quoted: false, drilled: false });
  const total = header.reduce((a, c) => a + Number(String(c.label).split(' ').pop()), 0);
  ok(total === visible.length, '面包屑合计等于可见技能数', `${total} vs ${visible.length}`);

  const unityGroup = [...sections.entries()].find(([, names]) => names.filter((n) => n.startsWith('unity-')).length >= 3);
  const unityCount = visible.filter((n) => n.name.startsWith('unity-')).length;
  ok(
    !!unityGroup && unityGroup[1].filter((n) => n.startsWith('unity-')).length === unityCount,
    '同族技能聚成一个组',
    `unity-* 共 ${unityCount} 个，成组 ${unityGroup ? unityGroup[1].length : 0}`
  );

  // 入口词（别名）通用约束：这些以前只在作者技能库用例里，SKIP 后等于没覆盖
  const noAlias = visible.filter((s) => !(s.aliases || []).length);
  ok(noAlias.length === 0, '每个技能都有入口词', noAlias.slice(0, 3).map((s) => s.name).join(','));

  const badLen = [];
  const dupAlias = [];
  for (const s of visible) {
    const list = s.aliases || [];
    for (const a of list) if (a.length < 1 || a.length > 16) badLen.push(`${s.name}:${a}`);
    if (new Set(list).size !== list.length) dupAlias.push(s.name);
  }
  ok(badLen.length === 0, '入口词长度都在 1–16 字', badLen.slice(0, 3).join(','));
  ok(dupAlias.length === 0, '入口词无重复', dupAlias.slice(0, 3).join(','));

  // 中文检索：查询里不含技能名，靠描述子串命中
  const cases = [
    ['改简历', 'resume-tune'],
    ['做落地页', 'landing-craft'],
    ['校准温度', 'lab-sensor'],
    ['unity 预制体', 'unity-prefab'],
    ['文档', 'docx-cleaner'],
    ['做海报', 'poster-maker'],
    ['图标系统', 'icon-set'],
    ['转场动效', 'micro-motion'],
    ['线上故障', 'log-triage'],
    ['幻灯片', 'deck-polish'],
  ];
  for (const [q, want] of cases) {
    const r = await src.candidates({ sessionId: 'FX' }, { query: q, signal: {} });
    ok(r.length > 0 && r[0].name === want, `「${q}」→ ${want}`, r[0] ? r[0].name : '无结果');
  }

  // 空目录：计数与索引归零
  // 宿主顺序：先 header（芯片）再 candidates（分组）。
  // 装完技能第一次打开时，芯片不能还挂着旧数字，否则就是「设计 23 / 设计与视觉 · 24」。
  {
    catalog = visible.map((s) => ({ name: s.name, description: s.desc }));
    const crumbsBefore = src.header({ sessionId: 'ORD' }, { query: '', quoted: false, drilled: false });
    const sumBefore = crumbsBefore.reduce((a, c) => a + Number(String(c.label).split(' ').pop()), 0);

    catalog = [...catalog, { name: 'zz-order-probe', description: '一个用于验证渲染顺序的技能' }];
    await src.candidates({ sessionId: 'ORD' }, { query: '', signal: {} });

    // 同一批 crumb 对象（宿主按引用保存），读到的数字必须已更新
    const sumAfter = crumbsBefore.reduce((a, c) => a + Number(String(c.label).split(' ').pop()), 0);
    ok(sumAfter === catalog.length, '先 header 后 candidates：芯片数字就地同步', `${sumBefore} → ${sumAfter}，目录 ${catalog.length}`);
    ok(sumAfter > sumBefore, '新增技能后芯片总数变大', `${sumBefore} → ${sumAfter}`);
  }

  // 空目录：计数与索引归零
  catalog = [];
  const empty = await src.candidates({ sessionId: 'FX2' }, { query: '', signal: {} });
  ok(empty.length === 0, '空目录返回 0 项', String(empty.length));
  const h2 = src.header({ sessionId: 'FX2' }, { query: '', quoted: false, drilled: false });
  const t2 = h2.reduce((a, c) => a + Number(String(c.label).split(' ').pop()), 0);
  ok(t2 === 0, '空目录后合计归零', String(t2));
  for (const test of ['verify-resilience.mjs', 'verify-host-resilience.mjs']) {
    const result = run(test, [HERE, join(home, 'local-plugins', 'dsh-skill-categories')]);
    console.log(result.out);
    ok(result.code === 0, test + ' 隔离回归通过');
  }
} catch (e) {
  if (!/^(ingest|build|aliases|pack)\.mjs$/.test(String(e.message))) {
    console.error('异常：' + e.message);
    fail++;
  }
} finally {
  restore();
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
