import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import createTorrent from "create-torrent";
import parseTorrent from "parse-torrent";
import { DockerRuntime } from "../src/plus/vpn/runtime";
import { QbittorrentBackend } from "../src/plus/backends/qbittorrent";

const execFileAsync = promisify(execFile);
const rootBase = path.resolve("work", "verify-managed");
const waitFor = async (probe: () => Promise<boolean>, description: string, timeoutMs = 45_000) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await probe()) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${description}`);
};
const makeBytes = (size: number, salt: number) => {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 71 + (i >>> 4) * (salt + 13) + salt) & 255;
  return bytes;
};
const makeTorrent = (file: string) => new Promise<Buffer>((resolve, reject) => {
  createTorrent(file, { announce: [], pieceLength: 16 * 1024 }, (error, data) => error ? reject(error) : resolve(Buffer.from(data)));
});
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const compose = (project: string, file: string, ...args: string[]) => execFileAsync("docker", ["compose", "-p", project, "-f", file, ...args], { timeout: 20_000 }).then(x => x.stdout.trim());
const qbitPost = async (baseUrl: string, password: string, route: string, fields: Record<string,string>) => {
  const origin = new URL(baseUrl).origin;
  const login = await fetch(`${origin}/api/v2/auth/login`, {
    method: "POST", headers: { Origin: origin, Referer: `${origin}/`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "admin", password }),
  });
  const cookie = login.headers.get("set-cookie")?.match(/(?:^|,\s*)((?:QBT_)?SID(?:_\d+)?=([^; ,]+))/i)?.[1];
  const loginText = (await login.text()).trim();
  if (!login.ok || !(loginText === "Ok." || login.status === 204) || !cookie) throw new Error("qBittorrent WebUI login for peer injection failed");
  const result = await fetch(`${origin}/api/v2/${route}`, {
    method: "POST", headers: { Origin: origin, Referer: `${origin}/`, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  if (!result.ok || (await result.text()).trim() === "Fails.") throw new Error("qBittorrent rejected a controlled API request");
};
const addPeer = (baseUrl:string,password:string,hash:string,peer:string) => qbitPost(baseUrl,password,"torrents/addPeers",{hashes:hash,peers:peer});
const scrub = (input: string, secrets: string[]) => secrets.reduce((value, secret) => secret ? value.replaceAll(secret, "[redacted]") : value, input).replace(/(?:password|token|SID)=?[^\s&]*/gi, "[redacted]");

let runtime: DockerRuntime | undefined;
let workDir: string | undefined;
const assertions: string[] = [];
const secretValues: string[] = [];
const pass = (label: string) => { assertions.push(label); console.log(`PASS ${label}`); };

try {
  await mkdir(rootBase, { recursive: true });
  workDir = await mkdtemp(path.join(rootBase, "run-"));
  const stateDir = path.join(workDir, "state");
  const downloadDir = path.join(workDir, "downloads");
  await mkdir(downloadDir, { recursive: true });
  const password = randomBytes(32).toString("base64url");
  const token = randomBytes(32).toString("base64url");
  secretValues.push(password, token);
  runtime = new DockerRuntime({
    projectDir: process.cwd(), stateDir, downloadDirs: [downloadDir],
    uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000,
    workerToken: token, qbitPassword: password, workerPort: 19162, qbitPort: 18080,
    healthWaitMs: 60_000,
  });
  const status = await runtime.start("direct");
  if (status.state !== "Direct") throw new Error(`Managed runtime did not start: ${status.message || status.state}`);
  const baseUrl = runtime.qbitUrl;
  const deniedInside = await compose(runtime.projectName, runtime.composePath, "exec", "-T", "controller", "node", "-e", "fetch('http://127.0.0.1:18080/api/v2/app/version').then(r=>{console.log(r.status)})");
  if (!new Set(["401", "403"]).has(deniedInside)) throw new Error(`Unauthenticated qBittorrent request inside the shared gateway namespace returned HTTP ${deniedInside}`);
  const deniedHost = await fetch(`${baseUrl}/api/v2/app/version`);
  if (![401, 403].includes(deniedHost.status)) throw new Error(`Unauthenticated qBittorrent request from the host returned HTTP ${deniedHost.status}`);
  pass("managed qBittorrent rejects unauthenticated HTTP access");

  const configPath = path.join(stateDir, "qbittorrent", "qBittorrent", "config", "qBittorrent.conf");
  const hostConfigDigest = digest(await readFile(configPath));
  const mountedConfigDigest = await compose(runtime.projectName, runtime.composePath, "exec", "-T", "qbittorrent", "sh", "-c", "sha256sum /config/qBittorrent/config/qBittorrent.conf | cut -d ' ' -f 1");
  if (mountedConfigDigest !== hostConfigDigest) throw new Error("qBittorrent container did not read the preseeded WebUI configuration file");

  const diagnosticFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname.endsWith("/torrents/add")) {
      const body = (await response.clone().text()).trim();
      if (body && body !== "Ok.") console.error(`qBittorrent add response: ${scrub(body, secretValues)}`);
    }
    return response;
  };
  const newBackend = () => new QbittorrentBackend({ baseUrl, username: "admin", password, fetch: diagnosticFetch });
  let backend = newBackend();
  await backend.start();
  pass("qBittorrent adapter authenticates and starts against the managed instance");
  // Controlled localhost peers use plaintext TCP; external discovery is disabled.
  // These fixture preferences do not change the product defaults.
  await backend.applySettings({dht:false,pex:false,utp:false});
  await qbitPost(baseUrl,password,"app/setPreferences",{json:JSON.stringify({encryption:2,lsd:false,enable_multi_connections_from_same_ip:true})});

  const fixtureDir = path.join(downloadDir, "fixtures");
  await (await import("node:fs/promises")).mkdir(fixtureDir, { recursive: true });
  const launchSeed = async (file: string) => {
    const output = "/tmp/controlled-seed-port.json";
    const code = `import WebTorrent from 'webtorrent'; import {writeFile} from 'node:fs/promises'; const c=new WebTorrent({dht:false,tracker:false,lsd:false,utp:false,torrentPort:0});c.seed(${JSON.stringify(file)},{announce:[]},async t=>{await writeFile(${JSON.stringify(output)},JSON.stringify({port:c.torrentPort}));});setTimeout(()=>c.destroy(()=>process.exit(0)),180000);`;
    await compose(runtime!.projectName, runtime!.composePath, "exec", "-T", "controller", "rm", "-f", output);
    await compose(runtime!.projectName, runtime!.composePath, "exec", "-T", "-d", "controller", "node", "--input-type=module", "-e", code);
    let port = 0;
    await waitFor(async () => { try { port = JSON.parse(await compose(runtime!.projectName, runtime!.composePath, "exec", "-T", "controller", "cat", output)).port; return port > 0; } catch { return false; } }, "in-namespace controlled seed");
    return `127.0.0.1:${port}`;
  };
  const original = makeBytes(2 * 1024 * 1024, 17);
  const sourcePath = path.join(fixtureDir, "managed-transfer.bin");
  await writeFile(sourcePath, original);
  const torrentBytes = await makeTorrent(sourcePath);
  const parsed: any = await parseTorrent(torrentBytes);
  let peer = await launchSeed(sourcePath);
  const id = await backend.add({ torrentBase64: torrentBytes.toString("base64"), savePath: downloadDir, paused: true });
  if (id !== parsed.infoHash.toLowerCase()) throw new Error("qBittorrent adapter returned the wrong torrent hash");
  await waitFor(async () => (await backend.list()).some(row => row.id === id && row.state === "paused"), "explicit paused state");
  await backend.applySettings({ downloadLimitKiB: 128 });
  await backend.resume(id);
  await addPeer(baseUrl, password, id, peer);
  await waitFor(async () => {
    const row = (await backend.list()).find(item => item.id === id);
    return !!row && row.downloaded > 0 && row.progress < 1;
  }, "actual in-progress qBittorrent peer transfer");
  await backend.pause(id);
  await waitFor(async () => (await backend.list()).some(row => row.id === id && row.state === "paused"), "settled pause state");
  const paused = (await backend.list()).find(row => row.id === id)!;
  if (paused.state !== "paused") throw new Error(`qBittorrent did not pause the live transfer (state ${paused.state})`);
  pass("torrent file imports, reports verified-piece/export details, and pauses a live transfer");
  const details = await backend.details(id);
  if (!details.files.some(file => file.size === original.length)) throw new Error("qBittorrent details did not report the imported file");
  const exported: any = await parseTorrent(await backend.exportTorrent(id));
  if (exported.infoHash !== parsed.infoHash || exported.name !== parsed.name || exported.length !== parsed.length) throw new Error("qBittorrent export metadata did not match the source torrent");
  const pieces = await backend.pieces(id);
  if (!pieces || !pieces.states.includes("verified")) throw new Error("qBittorrent did not report any verified pieces after the partial transfer");
  pass("qBittorrent details, verified piece state, and exported torrent metadata match the source");

  await runtime.stop();
  const restarted = await runtime.start("direct");
  if (restarted.state !== "Direct") throw new Error("Managed qBittorrent runtime did not restart");
  backend = newBackend();
  await backend.start();
  await waitFor(async () => (await backend.list()).some(row => row.id === id && row.state === "paused"), "persisted paused torrent after restart");
  const persisted = (await backend.list()).find(row => row.id === id)!;
  if (persisted.progress >= 1) throw new Error("Test transfer unexpectedly completed before persistence check");
  peer = await launchSeed(sourcePath);
  await backend.resume(id);
  await addPeer(baseUrl, password, id, peer);
  await waitFor(async () => (await backend.list()).some(row => row.id === id && row.progress >= 1), "resumed qBittorrent transfer after restart", 60_000);
  const outputPath = path.join(downloadDir, path.basename(sourcePath));
  if (digest(await readFile(outputPath)) !== digest(original)) throw new Error("Downloaded bytes did not match the generated source SHA-256");
  pass("restart preserves the manual pause and resume downloads bytes with matching SHA-256");

  await backend.pause(id);
  await waitFor(async () => (await backend.list()).some(row => row.id === id && ["completed", "paused"].includes(row.state)), "settled completed pause");
  await rm(outputPath);
  await backend.recheck(id);
  await waitFor(async () => (await backend.list()).some(row => row.id === id && row.progress < 1 && row.state !== "checking"), "missing file detected by recheck");
  // A separate minimal TCP seed gives recheck recovery a fresh, explicit bitfield.
  // It serves the same generated bytes; qBittorrent still verifies every piece.
  const repairPortFile="/tmp/controlled-repair-port.json";
  const repairCode = `import net from 'node:net';import Wire from 'bittorrent-protocol';import {readFile,writeFile} from 'node:fs/promises';import{randomBytes}from'node:crypto';
    const bytes=await readFile(${JSON.stringify(sourcePath)});const hash=${JSON.stringify(id)};const size=16384;const count=Math.ceil(bytes.length/size);const bits=Buffer.alloc(Math.ceil(count/8),255);if(count%8)bits[bits.length-1]=255<<(8-count%8);
    const sockets=new Set();const server=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));const wire=new Wire();wire.on('error',()=>socket.destroy());socket.on('error',()=>{});socket.pipe(wire).pipe(socket);
      wire.on('handshake',remote=>{if(remote!==hash){socket.destroy();return;}wire.handshake(hash,randomBytes(20),{fast:false,dht:false});wire.bitfield(bits);wire.unchoke();});
      wire.on('request',(index,offset,length,reply)=>{const start=index*size+offset;if(index>=count||length>16384||start+length>bytes.length){reply(new Error('invalid request'));return;}reply(null,bytes.subarray(start,start+length));});
    });server.listen(0,'127.0.0.1',async()=>writeFile(${JSON.stringify(repairPortFile)},JSON.stringify({port:server.address().port})));setTimeout(()=>{for(const s of sockets)s.destroy();server.close(()=>process.exit(0));},180000);`;
  await compose(runtime.projectName,runtime.composePath,"exec","-T","-d","controller","node","--input-type=module","-e",repairCode);
  let repairPort=0;await waitFor(async()=>{try{repairPort=JSON.parse(await compose(runtime!.projectName,runtime!.composePath,"exec","-T","controller","cat",repairPortFile)).port;return repairPort>0;}catch{return false;}},"explicit-bitfield repair seed");
  peer=`127.0.0.1:${repairPort}`;
  await backend.resume(id); await addPeer(baseUrl,password,id,peer);
  let lastPeerAttempt=0;
  await waitFor(async () => {
    const row=(await backend.list()).find(row=>row.id===id);
    // Native recheck finishes asynchronously and may settle back into stoppedDL.
    // Retry the explicit resume/controlled peer only after checking has settled.
    if(row && row.state!=="checking" && row.progress<1 && Date.now()-lastPeerAttempt>2000) {
      lastPeerAttempt=Date.now();
      if(row.state==="paused") await backend.resume(id);
      if(!row.peers) await addPeer(baseUrl,password,id,peer);
    }
    return !!row && row.progress>=1;
  }, "missing file restored from verified peer", 60_000);
  if (digest(await readFile(outputPath)) !== digest(original)) throw new Error("Rechecked missing file was not repaired correctly");
  pass("missing file recheck and resumed peer transfer restore matching SHA-256");
  await backend.pause(id);
  await backend.remove(id, false);
  if ((await backend.list()).some(row => row.id === id)) throw new Error("qBittorrent still listed a removed torrent");
  if (digest(await readFile(outputPath)) !== digest(original)) throw new Error("remove without delete removed or damaged the downloaded data");
  pass("remove without delete removes the torrent while preserving downloaded data");

  const magnetSource = path.join(fixtureDir, "metadata-only.bin");
  const magnetBytes = makeBytes(48 * 1024, 91);
  await writeFile(magnetSource, magnetBytes);
  const magnetTorrentBytes = await makeTorrent(magnetSource);
  const magnetMeta: any = await parseTorrent(magnetTorrentBytes);
  peer = await launchSeed(magnetSource);
  const magnet = `magnet:?xt=urn:btih:${magnetMeta.infoHash}&dn=${encodeURIComponent(path.basename(magnetSource))}`;
  const magnetId = await backend.add({ magnet, savePath: downloadDir, paused: false });
  await addPeer(baseUrl, password, magnetId, peer);
  await waitFor(async () => (await backend.details(magnetId)).files.some(file => file.size === magnetBytes.length), "magnet metadata exchange");
  await backend.pause(magnetId);
  pass("magnet add acquires real metadata from the controlled peer");

  console.log(`Managed backend acceptance passed (${assertions.length} checks).`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Managed backend acceptance failed after ${assertions.length} checks: ${scrub(message, secretValues)}`);
  process.exitCode = 1;
} finally {
  try { if (runtime) await runtime.stop(); } catch { /* keep original failure */ }
  if (workDir) await rm(workDir, { recursive: true, force: true });
}
