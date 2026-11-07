// Node >=20. Runs the real generated client in a simulated host; no DSH config changes.
// Usage: node outputs/repro-client.mjs [repository] [plugin directory]
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { pluginDir } from './paths.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(process.argv[2] || here);
const plugin = resolve(process.argv[3] || pluginDir());
const code = readFileSync(resolve(plugin, 'lib/client.js'), 'utf8');
const catalog = JSON.parse(readFileSync(resolve(repo, 'index.json'), 'utf8')).skills.filter(s => s.userInvocable).map(s => ({ name: s.name, description: s.desc }));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const deferred = () => { let done, fail; const promise = new Promise((r,j) => { done=r; fail=j; }); return { promise, done, fail }; };
const response = skills => ({ ok: true, value: { skills } });
const results = [];
function check(id, expected, actual, ok) { const r = { id, expected, actual, ok }; results.push(r); console.log(JSON.stringify(r)); }
function harness({ remoteList, original, items = catalog, storage = new Map() } = {}) {
  let current = items;
  let captured;
  const sandbox = { console, setTimeout, clearTimeout, setInterval, clearInterval, performance, AbortController,
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,String(v)) },
    document: { getElementById: () => null, createElement: () => ({ style: {}, dataset: {}, setAttribute() {} }), head: { appendChild() {} } },
    addEventListener() {}, removeEventListener() {},
    atob: s => Buffer.from(s,'base64').toString('binary'), btoa: s => Buffer.from(s,'binary').toString('base64'),
    __ModuleLoader__: { load: c => captured = c }
  };
  sandbox.window = sandbox;
  vm.runInNewContext(code, sandbox);
  const api = captured.factory(() => { throw Error('unexpected require'); });
  api.diagnostics.setSemHooks({ importLib: () => new Promise(() => {}) });
  const src = { trigger: '/', name: 'skill', order: 2,
    candidates: original || (async (_s, r) => current.filter(s => !r.query || s.name.includes(r.query))),
    onPick: () => ({ text: '/' }) };
  const services = { inputTriggers: { live: { sources: [src] } }, sessions: {
    subagentAddress: () => undefined, binding: () => ({}),
    using: async (_id,_options,fn) => fn({ binding: { session: { getSnapshot: () => ({ openState:'open' }) } } })
  } };
  if (remoteList) services.remote = { skills: { list: remoteList } };
  const ctx = { ...services, get: n => services[n], inject: (_deps, cb) => cb(ctx), effect: fn => fn() };
  api.apply(ctx);
  return { api, src, storage, set: v => current = v,
    query: (q = '', sessionId = 'S', signal = new AbortController().signal) => src.candidates({ sessionId }, { query: q, signal }),
    header: (query = '') => src.header({ sessionId: 'S' }, { query }),
    dispose: () => api.dispose() };
}

// Slow fresh RPC, with a cached original source ready immediately.
{
  let calls = 0;
  const h = harness({ remoteList: async () => { calls++; await sleep(900); return response(catalog); } });
  const t = performance.now(); await h.query(); const ms = Math.round(performance.now()-t);
  check('slow-fresh-rpc', 'cached menu available within 300 ms', { ms, calls }, ms < 300);
  h.dispose();
}
// A request that never settles must not permanently disable the whole menu.
{
  const h = harness({ remoteList: () => new Promise(() => {}) });
  const outcome = await Promise.race([h.query('landing-craft').then(() => 'returned'), sleep(600).then(() => 'still pending')]);
  check('hung-fresh-rpc', 'exact search returns despite stalled RPC', outcome, outcome === 'returned'); h.dispose();
}
// The optional built-in fuzzy branch must not hold up an exact local hit.
{
  const h = harness({ remoteList: async () => response(catalog), original: () => new Promise(() => {}) });
  const outcome = await Promise.race([h.query('landing-craft').then(() => 'returned'), sleep(600).then(() => 'still pending')]);
  check('hung-fuzzy-branch', 'exact search returns from fresh catalog', outcome, outcome === 'returned'); h.dispose();
}
// Simulate rapid input while the first directory fetch is still pending.
{
  let calls = 0; const gate = deferred();
  const h = harness({ remoteList: () => { calls++; return gate.promise; } });
  const pending = ['', 'l', 'la', 'lan', 'land', 'landi', 'landin', 'landing'].map(q => h.query(q));
  await sleep(10); const before = calls; gate.done(response(catalog)); await Promise.all(pending);
  check('concurrent-directory-fetch', 'one shared pending directory request per session', before, before === 1); h.dispose();
}
// A timed-out task must release the single-flight slot and cannot commit late.
{
  const gates=[deferred(),deferred()];let calls=0;
  const h=harness({remoteList:()=>gates[calls++].promise});
  await h.query(); await sleep(10100);
  const newer=h.query();await sleep(10);
  check('timeout-retry-started','second directory request after timeout',calls,calls===2);
  const added={name:'new-arrival',description:'fresh installed skill'};
  gates[1].done(response([...catalog,added]));await newer;
  gates[0].done(response(catalog));await sleep(10);
  const final=await h.query();
  check('out-of-order-directory','late expired response cannot erase new skill',final.some(s=>s.name===added.name),final.some(s=>s.name===added.name));h.dispose();
}
// The real original source returns [] for an aborted request. A late fallback
// must not clear the category state established by a newer query.
{
  const gate=deferred();let calls=0;
  const h=harness({original:()=>++calls===1?gate.promise:Promise.resolve(catalog)});
  const controller=new AbortController();const old=h.query('','S',controller.signal);await sleep(10);
  controller.abort();await h.query();const before=h.header().map(c=>c.label);
  gate.done([]);await old;const after=h.header().map(c=>c.label);
  check('aborted-query-clears-counts','cancelled fallback preserves current counts',{before,after},JSON.stringify(after)===JSON.stringify(before)&&after.length>0);h.dispose();
}
// Cancelling one keystroke does not cancel a directory refresh shared by others.
{
  const gate=deferred();let calls=0,sharedSignal;
  const h=harness({remoteList:(_p,signal)=>{calls++;sharedSignal=signal;return gate.promise;}});
  const controller=new AbortController();const old=h.query('','S',controller.signal);await sleep(10);
  controller.abort();const newer=h.query();await sleep(10);gate.done(response(catalog));
  const [discarded,items]=await Promise.all([old,newer]);
  check('shared-refresh-survives-cancel','one independent refresh; old query discarded; new query succeeds',{calls,aborted:sharedSignal.aborted,old:discarded.length,new:items.length},calls===1&&!sharedSignal.aborted&&discarded.length===0&&items.length===catalog.length);h.dispose();
}
// Real host calls header before candidates. A newly formed group must get a chip.
{
  const h = harness(); await h.query(); const chips = h.header();
  h.set([...catalog, ...['one','two','three'].map(x => ({ name: 'zorblax-'+x, description: 'zorblax toolkit' }))]);
  const items = await h.query();
  const actual = { oldChipLabels: chips.map(c => c.label), nextHeaderLabels: h.header().map(c => c.label), grouped: items.filter(s => s.name.startsWith('zorblax')).map(s => s.section) };
  check('new-category-missing-chip', 'first menu opening includes newly created category chip', actual, chips.some(c => c.label.includes('zorblax'))); h.dispose();
}
// Incremental semantic indexing should retain unchanged vectors.
{
  const h = harness(); let embeddings = 0, loads = 0;
  h.api.diagnostics.setSemHooks({ importLib: async () => ({}), makePipe: async () => { loads++; return async () => { embeddings++; return { data: [1,0,0] }; }; } });
  const ready = async () => { for(let i=0;i<100;i++) { if(h.api.diagnostics.semanticStatus().status==='ready') return; await sleep(5); } throw Error('semantic harness not ready'); };
  await h.query(); await ready(); const before = embeddings;
  h.set([...catalog,{ name:'new-arrival',description:'new skill' }]); await h.query(); await ready();
  check('semantic-full-rebuild', 'one new vector for one added skill; reuse initialized pipeline', { initial:before, additional:embeddings-before, pipelineLoads:loads }, embeddings-before === 1 && loads === 1); h.dispose();
}
// Smoke checks ensure the simulated host exercises functional production code.
// Reuse an initializing model across catalog changes, not just a ready model.
{
  const h=harness();const gate=deferred();let imports=0,loads=0;
  h.api.diagnostics.setSemHooks({importLib:()=>{imports++;return gate.promise;},makePipe:async()=>{loads++;return async()=>({data:[1,0]});}});
  await h.query();h.set([...catalog,{name:'added-mid-load',description:'new'}]);await h.query();
  gate.done({});for(let i=0;i<100&&h.api.diagnostics.semanticStatus().status!=='ready';i++)await sleep(5);
  const status=h.api.diagnostics.semanticStatus();
  check('pending-model-shared','one model initialization; newest directory indexed',{imports,loads,indexed:status.indexed},imports===1&&loads===1&&status.indexed===catalog.length+1);h.dispose();
}
// Only changed text is recalculated; deletion requires no inference, and a new
// client instance reuses the surviving per-skill vectors from persistent cache.
{
  const storage=new Map();const h=harness({storage});let calls=0;
  const hooks={importLib:async()=>({}),makePipe:async()=>async()=>{calls++;return{data:[1,0]};}};
  const ready=async target=>{for(let i=0;i<100&&target.api.diagnostics.semanticStatus().status!=='ready';i++)await sleep(5);};
  h.api.diagnostics.setSemHooks(hooks);await h.query();await ready(h);const initial=calls;
  const changed=catalog.map((s,i)=>i? s:{...s,description:s.description+' updated'});
  h.set(changed);await h.query();await ready(h);
  check('changed-vector-only','one changed description produces one embedding',calls-initial,calls-initial===1);
  h.set(changed.slice(1));const before=calls;await h.query();await ready(h);
  check('deleted-vector-pruned','deletion without inference',{calls:calls-before,indexed:h.api.diagnostics.semanticStatus().indexed},calls===before&&h.api.diagnostics.semanticStatus().indexed===catalog.length-1);h.dispose();
  const next=harness({items:changed.slice(1),storage});next.api.diagnostics.setSemHooks(hooks);await next.query();await ready(next);
  check('persistent-vector-reuse','reload reuses unchanged per-skill vectors',calls-before,calls===before&&next.api.diagnostics.semanticStatus().indexed===catalog.length-1);next.dispose();
  const cache=JSON.parse(storage.get('dsh.skillcat.vec.v1'));
  delete cache.version;cache.v=cache.v.map(v=>v.slice(0,2));storage.set('dsh.skillcat.vec.v1',JSON.stringify(cache));
  const legacy=harness({items:changed.slice(1),storage});legacy.api.diagnostics.setSemHooks(hooks);await legacy.query();await ready(legacy);
  check('legacy-cache-migration','unchanged v1 vectors migrate without inference',calls-before,calls===before&&legacy.api.diagnostics.semanticStatus().indexed===catalog.length-1);legacy.dispose();
}
// A valid empty catalog must win over stale original results.
{
  const h=harness({remoteList:async()=>response([])});const items=await h.query();
  check('fresh-empty-authoritative','no deleted skills restored by fallback',items.length,items.length===0);h.dispose();
}
// Remove empty chips, and let a previously empty menu show newly added groups.
{
  const h=harness();await h.query();const old=h.header();h.set([]);await h.query();
  check('empty-chips-removed','zero total and no stale category buttons',old,old.length===1&&old[0].value==='root'&&old[0].label==='全部 0');
  const empty=h.header();h.set(catalog);await h.query();
  const total=empty.reduce((sum,c)=>sum+Number(c.label.split(' ').pop()),0);
  check('first-population-chips','retained empty header gains categories',total,total===catalog.length&&empty.some(c=>c.value.startsWith('cat:')));h.dispose();
}
// Refresh caches remain separate when switching sessions.
{
  let calls=0;const h=harness({remoteList:async p=>{calls++;return response(p.sessionId==='A'?catalog:catalog.slice(0,1));}});
  const a=await h.query('','A'),b=await h.query('','B'),again=await h.query('','A');
  check('session-cache-isolation','each session keeps its own catalog',{calls,a:a.length,b:b.length,again:again.length},calls===2&&a.length===catalog.length&&b.length===1&&again.length===catalog.length);h.dispose();
}
// Plugin disposal cancels pending work without allowing late state commits.
{
  const gate=deferred();let signal;const h=harness({remoteList:(_p,s)=>{signal=s;return gate.promise;}});
  const pending=h.query();await sleep(10);h.dispose();gate.done(response(catalog));const result=await pending;
  check('dispose-cancels-refresh','aborted RPC, empty obsolete result, no cache commit',{aborted:signal.aborted,count:result.length,fetches:h.api.diagnostics.freshFetches||0},signal.aborted&&result.length===0&&!h.api.diagnostics.freshFetches);
}
{
  const h = harness(); const all = await h.query(); const search = await h.query('做落地页');
  check('smoke-menu', 'all fixture skills visible', { expected:catalog.length, count:all.length }, all.length===catalog.length);
  check('smoke-chinese-search','landing-craft first', search[0]?.name, search[0]?.name==='landing-craft'); h.dispose();
}
console.log(
  '结果：'+results.filter(r=>r.ok).length+' 通过 / '+results.filter(r=>!r.ok).length+' 失败'
);
process.exitCode=results.some(r=>!r.ok)?1:0;
