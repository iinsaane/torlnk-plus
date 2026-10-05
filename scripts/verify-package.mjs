#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, lstat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docker = process.argv.includes('--docker');
const tmp = await mkdtemp(path.join(os.tmpdir(), 'torlnk-plus-package-check-'));

function runResult(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  return result;
}

function run(command, args, options = {}) {
  const result = runResult(command, args, options);
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${result.stderr}`);
  return result.stdout;
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Could not read temporary port'));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

try {
  const outDir = path.join(tmp, 'release');
  run(process.execPath, [path.join(root, 'scripts/package-release.mjs'), `--outdir=${outDir}`], { cwd: root, stdio: 'inherit' });
  const files = await readdir(outDir);
  const tgz = files.find((name) => name.endsWith('.tgz'));
  const source = files.find((name) => name.endsWith('-source.tar.gz'));
  if (!tgz || !source || !files.some((name) => name.endsWith('-checksums.json'))) throw new Error('Expected npm tgz, source tarball, and checksums manifest');
  const manifestName = files.find((name) => name.endsWith('-checksums.json'));
  const manifest = JSON.parse(await readFile(path.join(outDir, manifestName), 'utf8'));
  for (const name of [tgz, source]) {
    if (manifest.artifacts?.[name] !== sha256(await readFile(path.join(outDir, name)))) throw new Error(`Checksum mismatch for ${name}`);
  }

  const unpack = path.join(tmp, 'unpacked');
  const npmRoot = path.join(unpack, 'package');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(unpack);
  run('tar', ['-xzf', path.join(outDir, tgz), '-C', unpack]);
  const packageFiles = await readdir(npmRoot, { recursive: true });
  for (const required of ['package.json', 'LICENSE', 'README.md', 'README.upstream.md', 'VERIFICATION.md', 'SECURITY.md', 'CHANGELOG.md', 'docs/PUBLISHING.md', 'dist/cli.cjs', 'containers/worker.Dockerfile', 'containers/worker-package.json', 'containers/worker-package-lock.json', 'node_modules/webtorrent/package.json']) {
    if (!packageFiles.includes(required)) throw new Error(`npm archive is missing ${required}`);
  }
  const forbidden = packageFiles.filter((name) => /(^|\/)(\.env(?:\..*)?|\.state|\.ssh|secrets|work|\.git)(\/|$)|(^|\/)(?:id_rsa|id_ed25519)(?:$|\.)|\.(?:conf|ovpn|pem|key|p12|pfx)$/i.test(name));
  if (forbidden.length) throw new Error(`npm archive contains forbidden paths: ${forbidden.join(', ')}`);
  const publishedPkg = JSON.parse(await readFile(path.join(npmRoot, 'package.json'), 'utf8'));
  const workerPkg = JSON.parse(await readFile(path.join(npmRoot, 'containers/worker-package.json'), 'utf8'));
  const sourcePkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const workerKeys = ['name', 'version', 'type', 'license', 'engines', 'dependencies', 'overrides'];
  for (const key of workerKeys) {
    if (JSON.stringify(workerPkg[key]) !== JSON.stringify(sourcePkg[key])) throw new Error(`worker manifest ${key} differs from the source package`);
  }
  if (Object.keys(workerPkg).some((key) => !workerKeys.includes(key))) throw new Error('worker manifest contains source-only or development package metadata');
  const publishExpected = { ...sourcePkg };
  delete publishExpected.overrides;
  if (JSON.stringify(publishExpected) !== JSON.stringify(publishedPkg)) throw new Error('published manifest differs from root metadata beyond npm 12 bundled-override omission');
  if (publishedPkg.overrides) throw new Error('npm archive still contains unsupported bundled-dependency overrides');
  const workerLock = await readFile(path.join(npmRoot, 'containers/worker-package-lock.json'));
  const lock = JSON.parse(workerLock.toString('utf8'));
  const expectedWorkerLock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  expectedWorkerLock.packages[''] = {
    name: workerPkg.name,
    version: workerPkg.version,
    license: workerPkg.license,
    dependencies: workerPkg.dependencies,
    engines: workerPkg.engines,
  };
  for (const metadata of Object.values(expectedWorkerLock.packages)) delete metadata.inBundle;
  if (JSON.stringify(lock) !== JSON.stringify(expectedWorkerLock)) throw new Error('published worker lock differs from the root production graph');
  const workerRootLock = lock.packages?.[''];
  for (const key of ['name', 'version', 'license', 'dependencies', 'engines']) {
    if (JSON.stringify(workerRootLock?.[key]) !== JSON.stringify(workerPkg[key])) throw new Error(`worker lock root ${key} differs from worker package manifest`);
  }
  if (Object.keys(workerRootLock ?? {}).some((key) => !['name', 'version', 'license', 'dependencies', 'engines'].includes(key))) throw new Error('worker lock root retains source-only or development metadata');
  if (Object.values(lock.packages ?? {}).some((metadata) => Object.hasOwn(metadata, 'inBundle'))) throw new Error('worker lock retains npm bundle metadata');
  const declaredBundles = [...(publishedPkg.bundleDependencies ?? [])].sort();
  if (declaredBundles.join('\0') !== Object.keys(publishedPkg.dependencies ?? {}).sort().join('\0')) throw new Error('published package does not bundle every production dependency');
  if (JSON.stringify(workerPkg.dependencies) !== JSON.stringify(publishedPkg.dependencies)) throw new Error('worker install dependencies differ from published direct dependencies');
  for (const [lockPath, metadata] of Object.entries(lock.packages ?? {})) {
    if (!lockPath.startsWith('node_modules/') || metadata.dev || metadata.devOptional) continue;
    const packageJson = path.join(npmRoot, lockPath, 'package.json');
    const installed = await readFile(packageJson, 'utf8').then(JSON.parse).catch((error) => {
      if (metadata.optional && error.code === 'ENOENT') return null;
      throw error;
    });
    if (!installed) {
      if (metadata.optional) continue;
      throw new Error(`bundled production dependency is missing: ${lockPath}`);
    }
    if (installed.version !== metadata.version) throw new Error(`bundled ${lockPath} version ${installed.version} differs from lock ${metadata.version}`);
    if (installed.name === 'ip') throw new Error(`unaliased ip package is reachable in the bundled dependency tree: ${lockPath}@${installed.version}`);
  }
  const aliasIp = await readFile(path.join(npmRoot, 'node_modules/ip/package.json'), 'utf8').then(JSON.parse);
  if (aliasIp.name !== '@bybrave/ip2' || aliasIp.version !== '3.0.0') throw new Error('tracker IP alias is missing or has the wrong version');

  const sourceListing = run('tar', ['-tzf', path.join(outDir, source)]);
  const sourceEntries = sourceListing.trim().split('\n');
  for (const required of ['package.json', 'package-lock.json', 'LICENSE', 'README.md', 'README.upstream.md', 'VERIFICATION.md', 'SECURITY.md', 'CHANGELOG.md', 'docs/PUBLISHING.md', 'src/', 'scripts/', 'containers/', 'dist/', 'preview/plus/', 'verification/', 'torlnk-plus', '.dockerignore', '.gitignore']) {
    if (!sourceEntries.some((entry) => entry.endsWith(`/${required}`) || entry.endsWith(`/${required}/`))) throw new Error(`source archive is missing ${required}`);
  }
  const sourceForbidden = sourceEntries.filter((name) => /(^|\/)(\.env(?:\..*)?|\.state|\.ssh|secrets|work|node_modules|\.git)(\/|$)|(^|\/)(?:id_rsa|id_ed25519)(?:$|\.)|\.(?:conf|ovpn|pem|key|p12|pfx)$/i.test(name));
  if (sourceForbidden.length) throw new Error(`source archive contains forbidden paths: ${sourceForbidden.join(', ')}`);

  const installPrefix = path.join(tmp, 'install');
  run('npm', ['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--cache', path.join(tmp, 'empty-npm-cache'), '--prefix', installPrefix, path.join(outDir, tgz)], { cwd: tmp, stdio: 'inherit' });
  const cli = path.join(installPrefix, 'node_modules/torlnk-plus/dist/cli.cjs');
  const help = run(process.execPath, [cli, '--help'], { cwd: tmp });
  if (!help.includes('torlnk-plus')) throw new Error('--help did not display the program help');
  const version = run(process.execPath, [cli, '--version'], { cwd: tmp });
  const pkg = publishedPkg;
  if (!version.includes(pkg.version)) throw new Error('--version does not match package metadata');
  if (help.includes('doctor')) {
    const doctorState = path.join(tmp, 'doctor-state-must-not-be-created');
    const env = {
      ...process.env,
      TORLNK_PLUS_STATE_DIR: doctorState,
      TORLNK_PLUS_PORT: String(await freePort()),
      TORLNK_PLUS_WORKER_PORT: String(await freePort()),
      TORLNK_PLUS_QBIT_PORT: String(await freePort()),
    };
    const doctor = runResult(process.execPath, [cli, 'doctor', '--json'], { cwd: tmp, env });
    let report;
    try { report = JSON.parse(doctor.stdout); } catch { throw new Error(`doctor did not return valid JSON: ${doctor.stdout}\n${doctor.stderr}`); }
    if (doctor.status !== 0 && doctor.status !== 1) throw new Error(`doctor exited unexpectedly with ${doctor.status}`);
    if (report.name !== 'torlnk-plus' || report.version !== pkg.version || !Array.isArray(report.checks) || typeof report.ok !== 'boolean') throw new Error('doctor JSON is missing versioned diagnostic checks');
    if (await lstat(doctorState).catch(() => null)) throw new Error('doctor created its isolated state directory');
  }
  const statusState = path.join(tmp, 'status-state-must-not-be-created');
  const status = runResult(process.execPath, [cli, 'status'], { cwd: tmp, env: { ...process.env, TORLNK_PLUS_STATE_DIR: statusState, TORLINK_NO_WEBRTC: '1' }, timeout: 20000 });
  const statusOutput = `${status.stdout}${status.stderr}`;
  if (status.status === 0 || statusOutput.trim().length === 0) throw new Error('isolated no-service status did not produce the expected connection failure');
  if (!/WebRTC peers disabled by TORLINK_NO_WEBRTC/i.test(statusOutput)) throw new Error('no-service status did not confirm the WebRTC stub fallback');
  if (await lstat(statusState).catch(() => null)) throw new Error('isolated no-service status created its state directory');

  if (docker) {
    const dockerfile = path.join(npmRoot, 'containers/worker.Dockerfile');
    if (!await stat(dockerfile).catch(() => null)) throw new Error('npm archive is missing worker Dockerfile');
    run('docker', ['build', '--no-cache', '-f', dockerfile, '-t', `torlnk-plus-worker-package-check:${pkg.version}`, npmRoot], { cwd: tmp, stdio: 'inherit' });
  }
  console.log(`Package verification passed: ${tgz}${docker ? ' (including worker image build)' : ''}`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
