import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, stat, rm } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { Supervisor } from '../src/plus/supervisor-core';
import { defaultPlusConfig } from '../src/plus/config';
const run = promisify(execFile);
const source = process.argv[2]; if (!source) throw new Error('Provide a WireGuard configuration path');
const digest = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex');
const original = await digest(source);
const base = path.resolve('work/vpn-acceptance'); await mkdir(base,{recursive:true});
const state = await mkdtemp(path.join(base,'run-'));
process.env.TORLNK_PLUS_WORKER_PORT='19166'; process.env.TORLNK_PLUS_QBIT_PORT='18086';
const supervisor = new Supervisor(process.cwd(),state,{token:randomBytes(32).toString('hex'),workerToken:randomBytes(32).toString('hex'),qbitPassword:randomBytes(32).toString('hex')});
const compose = async (...args:string[]) => run('docker',['compose','-p','torlnk-plus-'+createHash('sha1').update(state).digest('hex').slice(0,9),'-f',path.join(state,'compose.json'),...args]);
const pass = (label:string) => console.log('PASS '+label);
try {
  await supervisor.start();
  const profile = await supervisor.importProfile(source,{provider:'windscribe',name:'Windscribe acceptance'});
  const imported = path.join(state,'profiles',profile.id,'profile.conf');
  const files = await (await import('node:fs/promises')).readdir(path.dirname(imported));
  const privateFile = files.find(name=>name.endsWith('.conf'))!;
  if (((await stat(path.join(path.dirname(imported),privateFile))).mode & 0o777)!==0o600) throw new Error('Imported profile is not private');
  const config=defaultPlusConfig(); config.downloadDir=path.join(state,'downloads'); config.network={...config.network,mode:'vpn',profileId:profile.id};
  await supervisor.saveConfig(config);
  let snapshot = await supervisor.state();
  if(snapshot.snapshot.route.state!=='Protected' || snapshot.services.some(s=>s.state!=='healthy')) throw new Error('VPN stack not healthy');
  pass('Windscribe WireGuard tunnel and all six service health indicators are healthy');
  const probe = await compose('exec','-T','search','node','-e',"fetch('https://example.com',{signal:AbortSignal.timeout(15000)}).then(r=>{if(!r.ok)process.exit(1);console.log('ok')}).catch(()=>process.exit(1))");
  if(!probe.stdout.includes('ok')) throw new Error('Protected DNS/HTTPS probe failed');
  pass('Search worker resolves DNS and reaches HTTPS through the selected VPN namespace');
  await compose('stop','search');
  snapshot=await supervisor.state();
  if(snapshot.services.find(s=>s.service==='search')?.state!=='unavailable' || snapshot.services.find(s=>s.service==='controller')?.state!=='healthy' || snapshot.services.find(s=>s.service==='qbittorrent')?.state!=='healthy') throw new Error('Search failure was not reported independently');
  pass('Search worker failure is reported independently while controller and torrent clients remain healthy');
  await compose('start','search');
  const healthDeadline=Date.now()+15000;
  while(Date.now()<healthDeadline) { snapshot=await supervisor.state(); if(snapshot.services.find(s=>s.service==='search')?.state==='healthy') break; await new Promise(r=>setTimeout(r,200)); }
  if(snapshot.services.find(s=>s.service==='search')?.state!=='healthy') throw new Error('Search health failed to recover');
  await compose('exec','-T','gateway','ip','link','set','tun0','down');
  // The monitor uses health plus interface flags, so cached tunnel health cannot stay Protected.
  await new Promise(r=>setTimeout(r,3000)); snapshot=await supervisor.state();
  if(snapshot.snapshot.route.state!=='Blocked' || snapshot.config.network.mode!=='vpn') throw new Error('Tunnel loss did not remain blocked');
  let blocked=false;
  try { await compose('exec','-T','search','node','-e',"const net=require('node:net');const s=net.connect(443,'1.1.1.1',()=>{s.destroy();process.exit(0)});s.setTimeout(3000,()=>process.exit(2));s.on('error',()=>process.exit(2))"); } catch { blocked=true; }
  if(!blocked) throw new Error('External application TCP escaped after tunnel loss');
  pass('Live tunnel loss reports Blocked, keeps VPN selected, and firewall blocks application TCP');
  if(await digest(source)!==original) throw new Error('Original profile changed');
  pass('Original profile is unchanged and imported material is owner-only');
} catch(error) { console.error(error instanceof Error?error.message:'VPN verification failed');process.exitCode=1; }
finally { await supervisor.stop().catch(()=>{}); await compose('down','--remove-orphans').catch(()=>{}); await rm(state,{recursive:true,force:true}); }
