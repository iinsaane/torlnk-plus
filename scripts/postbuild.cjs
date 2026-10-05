'use strict';

const { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

const root = resolve(__dirname, '..');
const src = resolve(root, 'scripts/cli-entry.cjs');
const dest = resolve(root, 'dist/cli.cjs');

copyFileSync(src, dest);
// The WebRTC fallback stub must ship beside cli.cjs, which resolves it via
// __dirname when the node-datachannel binary is unavailable.
copyFileSync(resolve(root, 'scripts/webrtc-stub.mjs'), resolve(root, 'dist/webrtc-stub.mjs'));

// On Windows chmod is effectively a no-op, and npm re-applies bin permissions on install anyway, so a failure
// here shouldn't fail the build, but warn rather than swallow the error.
try {
  chmodSync(dest, 0o755);
} catch (err) {
  console.warn('postbuild: could not set executable bit on dist/cli.cjs:', err.message);
}

copyFileSync(resolve(root, 'scripts/native-loader.mjs'), resolve(root, 'dist/native-loader.mjs'));

// Keep a minimal worker-only npm manifest and lock. npm ci is sensitive to
// metadata that applies only to the development package, and the worker does
// not need the source package's scripts, bin, devDependencies, or bundling.
const containers = resolve(root, 'containers');
mkdirSync(containers, { recursive: true });
const sourcePackage = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const workerPackage = {
  name: sourcePackage.name,
  version: sourcePackage.version,
  type: sourcePackage.type,
  license: sourcePackage.license,
  engines: sourcePackage.engines,
  dependencies: sourcePackage.dependencies,
  overrides: sourcePackage.overrides,
};
const sourceLock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
sourceLock.packages[''] = {
  name: workerPackage.name,
  version: workerPackage.version,
  license: workerPackage.license,
  dependencies: workerPackage.dependencies,
  engines: workerPackage.engines,
};
for (const packageData of Object.values(sourceLock.packages)) delete packageData.inBundle;
writeFileSync(resolve(containers, 'worker-package.json'), `${JSON.stringify(workerPackage, null, 2)}\n`);
writeFileSync(resolve(containers, 'worker-package-lock.json'), `${JSON.stringify(sourceLock, null, 2)}\n`);
console.log('postbuild: wrote CLI assets and deterministic worker npm metadata');
