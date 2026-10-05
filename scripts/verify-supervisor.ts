import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { JsonClient } from '../src/plus/http';
import type { AppState } from '../src/plus/client';
const run = promisify(execFile);
const base = path.resolve('work/supervisor-acceptance'); await mkdir(base, { recursive: true });
const state = await mkdtemp(path.join(base, 'run-'));
const env = { ...process.env, TORLNK_PLUS_STATE_DIR: state, TORLNK_PLUS_PORT: '19161', TORLNK_PLUS_WORKER_PORT: '19164', TORLNK_PLUS_QBIT_PORT: '18084', TORLNK_PLUS_PROJECT_DIR: process.cwd() };
let client: JsonClient | undefined;
const wait = async (test: () => Promise<boolean>, label: string) => { const end = Date.now()+60000; while (Date.now()<end) { try { if(await test()) return; } catch {} await new Promise(r=>setTimeout(r,250)); } throw new Error('Timed out: '+label); };
const pass = (label: string) => console.log('PASS '+label);
try {
  await run(process.execPath, ['dist/cli.cjs','start'], { env });
  const startup = await run(process.execPath, ['dist/cli.cjs','status'], { env });
  const first: AppState = JSON.parse(startup.stdout);
  if(first.config.network.mode !== null || first.snapshot.route.state !== 'Blocked') throw new Error('First run must require routing choice');
  const credentials = JSON.parse(await readFile(path.join(state,'credentials.json'),'utf8'));
  client = new JsonClient('http://127.0.0.1:19161',credentials.token,180000);
  pass('CLI exits while the supervisor remains reachable; first run stays blocked until chosen');
  const config = first.config; config.downloadDir=path.join(state,'downloads'); config.network.mode='direct';
  await client.request('/config',{config});
  await wait(async()=> (await client!.request<AppState>('/state')).services.every(s=>s.state==='healthy'), 'all services healthy');
  pass('Explicit Direct setup starts controller, search, WebTorrent and qBittorrent with individual health');
  const wt='a'.repeat(40), qb='b'.repeat(40);
  const add = (hash:string,backend:string,paused:boolean) => client!.request('/command',{action:'add',input:{magnet:'magnet:?xt=urn:btih:'+hash,savePath:config.downloadDir,backend,paused}});
  await add(wt,'webtorrent',true); await add(qb,'qbittorrent',false); await add(wt,'qbittorrent',false);
  let live=await client.request<AppState>('/state');
  if(live.snapshot.torrents.length !== 2 || live.snapshot.torrents.find(t=>t.id===wt)?.backend!=='webtorrent') throw new Error('Duplicate ownership was not retained');
  if(live.snapshot.torrents.find(t=>t.id===wt)?.state!=='paused') throw new Error('Paused metadata torrent was not preserved');
  pass('Both clients operate together; cross-backend duplicates retain original ownership');
  await client.request('/route',{mode:'direct'});
  live=await client.request<AppState>('/state');
  await wait(async()=> {const s=await client!.request<AppState>('/state'); return s.snapshot.torrents.find(t=>t.id===wt)?.state==='paused' && s.snapshot.torrents.find(t=>t.id===qb)?.state!=='paused';}, 'routing restart pause and resume state');
  pass('Managed namespace replacement preserves manually paused and active transfers');
  config.backendSettings.maxDownloads=1; await client.request('/config',{config});
  const project='torlnk-plus-'+(await import('node:crypto')).createHash('sha1').update(state).digest('hex').slice(0,9);
  await run('docker',['compose','-p',project,'-f',path.join(state,'compose.json'),'stop','controller']);
  await new Promise(r=>setTimeout(r,2500));
  await run('docker',['compose','-p',project,'-f',path.join(state,'compose.json'),'start','controller']);
  await wait(async()=> {const s=await client!.request<AppState>('/state');return s.snapshot.route.state==='Direct' && s.services.find(h=>h.service==='controller')?.state==='healthy';}, 'controller crash and routing health recovery');
  await client.request('/command',{action:'resume',id:wt});
  await wait(async()=> (await client!.request<AppState>('/state')).snapshot.torrents.find(t=>t.id===wt)?.state==='queued', 'controller restores shared capacity policy');
  await client.request('/command',{action:'pause',id:wt});
  config.backendSettings.maxDownloads=3; await client.request('/config',{config});
  pass('Controller container restart restores shared capacity policy and preserves explicit pause');
  const source=path.join(state,'fixture.conf');
  await writeFile(source,'[Interface]\nPrivateKey = '+Buffer.alloc(32,7).toString('base64')+'\nAddress = 10.0.0.2/32\n[Peer]\nPublicKey = '+Buffer.alloc(32,8).toString('base64')+'\nEndpoint = 127.0.0.1:9\nAllowedIPs = 0.0.0.0/0\n',{mode:0o600});
  const profile=await client.request<{id:string}>('/profiles/import',{path:source});
  let failed=false; try { await client.request('/route',{mode:'vpn',profileId:profile.id}); } catch { failed=true; }
  live=await client.request<AppState>('/state');
  if(!failed || live.config.network.mode!=='vpn' || live.snapshot.route.state!=='Blocked') throw new Error('VPN failure did not remain blocked');
  pass('Failed VPN transition persists VPN selection and remains blocked without fallback');
  await client.request('/route',{mode:'direct'});
  live=await client.request<AppState>('/state');
  await wait(async()=> {const s=await client!.request<AppState>('/state'); return s.snapshot.torrents.find(t=>t.id===wt)?.state==='paused' && s.snapshot.torrents.find(t=>t.id===qb)?.state!=='paused';}, 'failure recovery preserves pause state');
  pass('Explicit Direct recovery restores only prior active transfers');
  const compose=JSON.parse(await readFile(path.join(state,'compose.json'),'utf8'));
  for(const name of ['controller','search','webtorrent','qbittorrent']) {
    const mounts: string[]=compose.services[name].volumes;
    if(mounts.some(m=>m.split(':')[0]===state || m.includes('/profiles:'))) throw new Error('Worker was given supervisor or VPN private state');
  }
  pass('Network workers have selected data/settings mounts, without private VPN or supervisor state');
  await client.request('/stop',{}); await new Promise(r=>setTimeout(r,300));
  try { await client.request('/state'); throw new Error('Service still running after stop'); } catch(e) { if(e instanceof Error && e.message==='Service still running after stop') throw e; }
  pass('Separate stop action shuts down background service');
} catch(error) { console.error(error instanceof Error ? error.message : 'Supervisor acceptance failed'); process.exitCode=1; }
finally {
  await client?.request('/stop',{}).catch(()=>{});
  try { const spec=path.join(state,'compose.json'); const project='torlnk-plus-'+(await import('node:crypto')).createHash('sha1').update(state).digest('hex').slice(0,9); await run('docker',['compose','-p',project,'-f',spec,'down','--remove-orphans']); } catch {}
  await rm(state,{recursive:true,force:true});
}
