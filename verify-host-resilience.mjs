// Isolated filesystem and installer tests. Creates fixtures only under work/.
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { pluginDir } from './paths.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const repo=resolve(process.argv[2] || here);
const plugin=resolve(process.argv[3] || pluginDir());
const root=mkdtempSync(join(tmpdir(),'skillcat-regression-'));
const results=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function check(id,expected,actual,ok){const r={id,expected,actual,ok};results.push(r);console.log(JSON.stringify(r));}
const skills=join(root,'skills');
const deep=join(skills,'probe','node_modules','dep','dist');
mkdirSync(deep,{recursive:true});
writeFileSync(join(skills,'probe','SKILL.md'),'---\nname: probe\ndescription: test\n---\n');
process.env.DSH_HOME=root;
process.env.AGENTS_SKILLS_DIR=skills;
const host=await import(pathToFileURL(join(plugin,'lib/index.js')).href);
let invalidations=0;const cleanup=[];
host.apply({skills:{invalidateCache(){invalidations++;},notifyChange(){}},effect(fn){cleanup.push(fn());}});
await sleep(100);
for(let i=0;i<3;i++){writeFileSync(join(deep,'irrelevant.js'),`// ${i}`);await sleep(450);}
check('irrelevant-dependency-writes','no skill catalog invalidation for node_modules file content changes',{writes:3,invalidations},invalidations===0);
writeFileSync(join(skills,'probe','SKILL.md'),'---\nname: probe\ndescription: changed\n---\n');await sleep(500);
check('skill-metadata-refresh','editing SKILL.md invalidates the directory',invalidations,invalidations===1);
mkdirSync(join(skills,'added'));writeFileSync(join(skills,'added','SKILL.md'),'---\nname: added\ndescription: added\n---\n');await sleep(500);
check('new-skill-refresh','new skill is still detected',invalidations,invalidations===2);
for(const fn of cleanup)fn?.();

// Only a synthetic profile is passed to rollback; no real installation is touched.
{
  const home=join(root,'rollback-home');const prof=join(home,'profiles','test');mkdirSync(prof,{recursive:true});
  const old={name:'test',dependencies:{base:'1'},dsh:{profile:{bundles:['base']}}};
  const current={name:'test',dependencies:{base:'1','dsh-skill-categories':'file:dummy','new-plugin':'1'},dsh:{profile:{bundles:['base','dsh-skill-categories','new-plugin']}}};
  writeFileSync(join(prof,'package.json.bak-skillcat-20260101'),JSON.stringify(old));
  writeFileSync(join(prof,'package.json'),JSON.stringify(current));
  const run=spawnSync(process.execPath,[join(repo,'rollback.mjs'),'--profile','test'],{env:{...process.env,DSH_HOME:home},encoding:'utf8'});
  const after=JSON.parse(readFileSync(join(prof,'package.json'),'utf8'));
  check('rollback-loses-later-plugin','rollback removes only skill-categories and preserves later installed plugin',{exit:run.status,bundles:after.dsh.profile.bundles,dependencies:after.dependencies},after.dependencies['new-plugin']==='1');
}

// Missing host entry: installer should reject before writing profile config.
{
  const home=join(root,'incomplete-home');const prof=join(home,'profiles','test');const lib=join(home,'local-plugins','dsh-skill-categories','lib');
  mkdirSync(prof,{recursive:true});mkdirSync(lib,{recursive:true});
  writeFileSync(join(lib,'client.js'),'// client only');
  const before=JSON.stringify({name:'test',dependencies:{base:'1'},dsh:{profile:{bundles:['base']}}});
  const pkgPath=join(prof,'package.json');writeFileSync(pkgPath,before);
  const run=spawnSync(process.execPath,[join(repo,'install.mjs'),'--profile','test'],{env:{...process.env,DSH_HOME:home},encoding:'utf8'});
  const after=readFileSync(pkgPath,'utf8');
  if(/EPERM/.test(run.stdout+run.stderr)) {
    const r={id:'incomplete-package-mutation',skipped:true,reason:'Sandbox denies directory link creation (EPERM); target failure path was not reached.'};results.push(r);console.log(JSON.stringify(r));
  } else check('incomplete-package-mutation','missing host entry is rejected without changing profile',{exit:run.status,changed:after!==before,output:run.stdout+run.stderr},run.status!==0&&after===before);
}
console.log('结果：'+results.filter(r=>r.ok).length+' 通过 / '+results.filter(r=>!r.skipped&&!r.ok).length+' 失败');
process.exitCode=results.some(r=>!r.skipped&&!r.ok)?1:0;
