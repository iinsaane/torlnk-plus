#!/usr/bin/env node
import { cp, lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outArg = args.find((arg) => arg.startsWith('--outdir='));
const outDir = path.resolve(root, outArg ? outArg.slice('--outdir='.length) : 'release');
const allowedSource = [
  'package.json', 'package-lock.json', 'LICENSE', 'README.md', 'README.upstream.md',
  'VERIFICATION.md', 'SECURITY.md', 'CHANGELOG.md', 'CONTRIBUTING.md',
  'src', 'scripts', 'containers', 'dist', 'preview/plus', 'verification', 'docs',
  'tsconfig.json', 'tsup.config.ts', 'vitest.config.ts',
  '.github/workflows/ci.yml', '.github/workflows/release.yml', '.dockerignore', '.gitignore', 'torlnk-plus',
];
const secretName = /(^|\/)(\.env(?:\..*)?|\.state|\.ssh|secrets)(\/|$)|(^|\/)(?:id_rsa|id_ed25519)(?:$|\.)|\.(?:conf|ovpn|pem|key|p12|pfx)$/i;
const tmp = await mkdtemp(path.join(os.tmpdir(), 'torlnk-plus-release-'));
const sourceStage = path.join(tmp, 'torlnk-plus-source');
const npmStage = path.join(tmp, 'npm-package');

function safePath(relative) {
  const normalized = relative.split(path.sep).join('/');
  if (secretName.test(normalized) || normalized.split('/').some((part) => part === 'node_modules' || part === '.git' || part === 'work')) {
    throw new Error(`Refusing private or generated path in release allowlist: ${normalized}`);
  }
  return normalized;
}

async function copyAllowedFiles(source, target, relative = '') {
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const rel = safePath(path.posix.join(relative, entry.name));
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    const info = await lstat(from);
    if (info.isSymbolicLink()) throw new Error(`Refusing symlink in release input: ${rel}`);
    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true });
      await copyAllowedFiles(from, to, rel);
    } else {
      await cp(from, to);
    }
  }
}

async function stageAllowlist(stage, allowlist) {
  await mkdir(stage, { recursive: true });
  for (const entry of allowlist) {
    const from = path.join(root, entry);
    try { await lstat(from); } catch { continue; }
    safePath(entry);
    const to = path.join(stage, entry);
    await mkdir(path.dirname(to), { recursive: true });
    const info = await lstat(from);
    if (info.isDirectory()) {
      await mkdir(to, { recursive: true });
      await copyAllowedFiles(from, to, entry);
    } else await cp(from, to);
  }
}

function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

function sha256(file) {
  return createHash('sha256').update(file).digest('hex');
}

try {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (!pkg.version || !Array.isArray(pkg.files)) throw new Error('Release requires a versioned package.json with an explicit files allowlist');
  for (const required of ['package.json', 'package-lock.json', 'LICENSE', 'README.md', 'README.upstream.md', 'VERIFICATION.md', 'CHANGELOG.md', 'SECURITY.md', 'docs/PUBLISHING.md', 'src', 'scripts', 'containers', 'dist', 'preview/plus', 'verification']) {
    if (!await lstat(path.join(root, required)).catch(() => null)) throw new Error(`Required source release input is missing: ${required}`);
  }
  if (!Array.isArray(pkg.bundleDependencies) || [...pkg.bundleDependencies].sort().join('\0') !== Object.keys(pkg.dependencies ?? {}).sort().join('\0')) {
    throw new Error('package.json bundleDependencies must name every direct production dependency');
  }
  await mkdir(outDir, { recursive: true });

  // Source archive: only these root entries are considered. Recursion still
  // rejects symlinks, credentials, local state, dependency trees, and work/.
  await stageAllowlist(sourceStage, allowedSource);
  const sourceName = `torlnk-plus-${pkg.version}-source`;
  const sourceFile = path.join(outDir, `${sourceName}.tar.gz`);
  run('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '--pax-option=delete=atime,delete=ctime', `--transform=s,^torlnk-plus-source,${sourceName},`, '-czf', sourceFile, '-C', tmp, path.basename(sourceStage)]);

  // npm archive is built from a separate stage with its own explicit file list.
  // Keep the package's actual published allowlist and metadata intact. In
  // particular, private:true is useful for local packaging and does not stop
  // npm pack or installation of the resulting tarball.
  await stageAllowlist(npmStage, pkg.files);
  // The source lock drives a clean offline production install for bundled deps;
  // npm 12 correctly excludes package-lock.json from the published tarball.
  await cp(path.join(root, 'package-lock.json'), path.join(npmStage, 'package-lock.json'));
  const npmPkg = { ...pkg };
  await writeFile(path.join(npmStage, 'package.json'), `${JSON.stringify(npmPkg, null, 2)}\n`);
  run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], { cwd: npmStage });
  // npm 12 refuses to pack bundled packages when overrides are present. The
  // exact source overrides have already shaped the clean lockfile install;
  // consumers get that locked graph in node_modules, so remove the ignored
  // override rules only from the staged published manifest.
  delete npmPkg.overrides;
  await writeFile(path.join(npmStage, 'package.json'), `${JSON.stringify(npmPkg, null, 2)}\n`);
  const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', outDir], {
    cwd: npmStage, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (packed.error) throw packed.error;
  if (packed.status !== 0) throw new Error(`npm pack exited with status ${packed.status}`);
  const packJson = JSON.parse(packed.stdout);
  const candidate = Array.isArray(packJson) ? packJson[0] : packJson[pkg.name] ?? Object.values(packJson)[0];
  const packInfo = Array.isArray(candidate) ? candidate[0] : candidate;
  if (!packInfo?.filename || !Array.isArray(packInfo.files)) throw new Error('npm pack returned an unsupported JSON result');
  const npmFile = path.join(outDir, packInfo.filename);

  const artifacts = {};
  for (const file of [sourceFile, npmFile]) artifacts[path.basename(file)] = sha256(await readFile(file));
  const manifest = { name: pkg.name, version: pkg.version, artifacts };
  await writeFile(path.join(outDir, `torlnk-plus-${pkg.version}-checksums.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ source: sourceFile, npm: npmFile, manifest: path.join(outDir, `torlnk-plus-${pkg.version}-checksums.json`) }, null, 2));
} finally {
  await rm(tmp, { recursive: true, force: true });
}
