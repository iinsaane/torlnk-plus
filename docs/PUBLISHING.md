# Publishing Torlnk+ alpha

The prepared version is `0.1.0-alpha.1`. Publish it as a GitHub prerelease and use the npm `alpha` tag. Keep TCP 443 and Stealth experimental. Only Linux x86_64 with rootful Docker is a supported alpha target.

## Review before uploading

- Read SECURITY.md, VERIFICATION.md, and CHANGELOG.md. Preserve distinctions between automated tests, maintainer-reported transfer success, and unverified environments/transports.
- GitHub authentication is verified as `iinsaane`. The intended repository is `iinsaane/torlnk-plus`; it has not been created or uploaded. Package metadata points to this destination. npm authentication and publisher ownership remain pending. Check package-name availability and publishing permissions before upload.
- The current Git origin points to upstream. Add a separate `fork` remote for the chosen repository; never push this fork's release to upstream origin.
- Retain LICENSE, README.upstream.md, and upstream attribution.
- Run the following from a development checkout with Docker available:

```sh
npm install --global --ignore-scripts npm@12.0.2
npm ci --ignore-scripts
npm run typecheck
npm test
npm audit --omit=dev --audit-level=high
npm run build
npm run verify:package -- --docker
npm run verify:managed
npm run verify:supervisor
npm run release:package
```

Live VPN validation uses a private profile outside the repository. The current release Gluetun pin still needs a live handshake. Stop any stack using the same WireGuard key before an isolated test to avoid changing its peer endpoint. It must never be needed by public CI. The read-only `verify:network` command checks an already running stack. Full leak testing remains a separate release requirement for a stable privacy claim. Review the high-severity container findings before approving any public alpha upload; there is no security sign-off yet.

## GitHub prerelease

Inspect the source archive and checksum manifest, commit the reviewed fork changes, then push only to the chosen fork remote. Tag the reviewed commit `v0.1.0-alpha.1`. Create a GitHub prerelease using CHANGELOG.md as the release notes and attach:

- `torlnk-plus-0.1.0-alpha.1-source.tar.gz`
- `torlnk-plus-0.1.0-alpha.1.tgz`
- `torlnk-plus-0.1.0-alpha.1-checksums.json`

The preparation workflow only uploads build artifacts to its workflow run. It does not create a GitHub release, push tags, or publish npm packages. CI has not run remotely until it is pushed to the new repository.

## npm alpha

`private: true` deliberately prevents publishing during local preparation. After approving the reviewed release and authenticating its npm publisher, remove that flag. The prepared repository/bugs metadata already points to `iinsaane/torlnk-plus`. Rebuild and reverify the exact final package because those edits change its checksums.

Authenticate using npm's supported login flow, then verify account and package ownership. Do not put credentials in repository files, archives, or CI logs. Confirm the dry run before publishing the exact tarball:

```sh
npm publish ./release/torlnk-plus-0.1.0-alpha.1.tgz --tag alpha --access public --ignore-scripts --dry-run
# After approval, the same command without --dry-run publishes it.
```

Published installations can use `npm install --global --ignore-scripts torlnk-plus@alpha`. Do not point the default `latest` tag at this alpha. Registry name/permission checks and actual GitHub/npm publication are pending until the destination accounts are selected.
