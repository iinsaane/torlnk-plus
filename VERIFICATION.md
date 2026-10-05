# Verification report

Alpha preparation checked locally on 2026-10-05. The current release passes the full regression suite, packaging checks, and isolated managed-backend/supervisor acceptance tests. Earlier UI inspection and live Windscribe evidence are dated 2026-10-04. Those live VPN checks used the previous image pins; the updated Gluetun image has not completed a live Windscribe handshake. This is a working Linux alpha, not certification of every transport or failure scenario in the release plan.

## Passed

| Area | Evidence |
| --- | --- |
| Build and regression suite | TypeScript check and production build pass. All **589 tests across 75 files** pass, including retained upstream tests and fork tests. |
| WebTorrent transfer | Real local peers transfer generated data with matching SHA-256; metadata export, verified pieces, metadata delay, pause/restart, and repair after corrupting saved data pass. Metadata-less magnets remain magnets across checkpoints. Lifetime upload totals survive restore. Errored records with missing metadata can be removed without deleting data. |
| qBittorrent transfer | Managed official qBittorrent 5.2.4 container authenticates and transfers generated files with matching SHA-256. Torrent import, magnet metadata exchange, throttling, pause/resume, restart preserving manual pause, details, piece states, metadata export, missing-file detection/recheck/repair with matching SHA-256, and removal retaining files pass. All eight managed-backend acceptance checks pass. |
| Mixed operation | Real detached supervisor runs both clients; duplicate hashes retain their original backend. Gateway namespace replacement preserves manual pauses and resumes prior active transfers. Restarting the controller after a monitored outage restores shared transfer-capacity policy. All nine supervisor acceptance checks pass, including a repeat against the final workers after removing npm/npx. |
| Background lifetime | The CLI exits while its supervisor remains reachable. The explicit stop action shuts down the service and managed containers. |
| Routing failure/recovery | An unreachable WireGuard endpoint causes a blocked transition with VPN still selected. Explicit Direct recovery restores prior active transfers; no automatic fallback occurs. |
| Live Windscribe | On 2026-10-04, the supplied Amsterdam WireGuard profile established a Protected tunnel with Gluetun 3.40.0 and the previous worker images. Controller, search, gateway, supervisor, and both backends report healthy. The search container resolves DNS and fetches HTTPS through the VPN namespace. |
| Live tunnel loss | With the previous image pins on 2026-10-04, taking `tun0` down changes status to Blocked and an external TCP probe from the search container fails. VPN remains selected. A delegated gateway-loss check also blocked external TCP. |
| Limited traffic capture | A delegated capture on the gateway's external interface observed zero clear TCP packets to the controlled `1.1.1.1:443` target during protected operation and tunnel loss. This only covers that probe and those conditions. |
| Service health | A real stopped search container is reported unavailable while controller and torrent backends remain healthy; restarting search restores health. The interface shows six services, check times, and last successful checks. UI tests cover independent failure at 48 and 100 columns, one persistent bottom status row, and access to Health without leaving Settings with Esc. |
| Settings and ownership | Fixtures cover atomic persistence/validation, supported and disabled controls, shared concurrency/seeding policy, backend failure/recovery, legacy backup/import, retry of interrupted migration, and cross-backend duplicate prevention. Controller history retains additions, first completion, removal, and re-add generations across restart; owner-only files, bounded retention, interrupted-save recovery, and overlapping settings/polling checks pass. |
| Piece rendering | Fixtures cover sparse/active/unknown pieces, byte weighting for a shorter final piece, large maps, visible-only polling, resize, and narrow terminals. Finished/cancelled WebTorrent reservations are no longer shown as active. |
| Isolation and authentication | Managed qBittorrent rejects unauthenticated requests from host and inside the namespace. Management endpoints publish only on loopback. Real supervisor checks confirm network workers do not mount private VPN profiles or supervisor credentials. Only the VPN gateway receives network administration privileges. |
| Profile protection | The supplied original file is unchanged. Imported/runtime copies are owner-only. WireGuard keys are not printed. Parser tests reject executable hooks and external profile/certificate references, including OpenVPN long-option forms. |
| Local UI launch | Updated production UI reopened in Alacritty. Latest live status confirms Protected routing with all six services healthy; the UI update preserves the running service and torrent records. No gateway transition was needed for the UI update. |
| Command palette and removal | Ctrl+P works from every view/editor; search filtering, navigation, disabled explanations, sanitizer, and narrow layout checks pass. UI/RPC fixtures remove selected qBittorrent and WebTorrent download and seed entries with explicit `deleteData: false`, refresh both lists, and preserve entries on backend errors. Tests cover completed/paused seeds, stale selection after an empty view, modal shortcut/polling isolation, retained search/settings edits and detail scroll, and external VPN changes surviving subsequent settings saves. Real file-retention evidence from controlled backend tests is listed above; live user torrents were not used for removal tests. |
| UI inspection | The original search-first home, results, downloads, expanded details, Everyday/Advanced settings, and Health frames were rendered in color at 48, 80, and 100 columns; home, command palette, settings, and health also fit 32 columns. Palette and removal-action previews, plus Seeding, were independently inspected. Screens were visually inspected. Keyboard tests cover 1→2→3→4→5 without Esc, numeric field editing, retained settings drafts, search spaces and caret editing, letter shortcuts during typing, and per-download backend selection. Compact rows retain metrics and one real piece map; detail paging, footer visibility, and pending piece-poll recovery pass. Captures use synthetic fixture data, not private profile material. |

## Transport readiness

| Transport | Status |
| --- | --- |
| Direct | Live managed transfers and mixed-client lifecycle checks pass. |
| Windscribe WireGuard | Live handshake, DNS/HTTPS, service health, tunnel-loss and blocked-egress checks passed with the previous Gluetun 3.40.0 pin. The release uses 3.41.3; a live handshake with that image is pending. Port 443 is **UDP**, not UDP bypass. |
| Generic WireGuard | Import and runtime fixtures pass; additional providers have not been tested live. |
| OpenVPN TCP 443 | Import/container configuration implemented and fixture-tested. **Not release-ready:** no matching live profile/credentials or UDP-blocked-network test. |
| Windscribe Stealth | Official proxy source is pinned and its container builds; type-2 TLS command, explicit endpoint/SNI, restricted relay egress, and preservation of inner CA verification are fixture-tested. **Not release-ready:** live TLS relay/OpenVPN handshake, DNS, and torrent transfer remain unverified. |

## Remaining release checks and limitations

- Full packet-capture coverage of startup, all gateway/worker/controller crashes, restart, and mode changes remains unverified. The limited capture and live probes above do not establish that broader claim.
- The manually forwarded-port firewall/listener setting is implemented. Provider-assigned inbound connectivity has not been tested live.
- Torrent file contents were independently hash-verified through both engines in Direct mode. The maintainer reported a successful local torrent transfer on 2026-10-04 after the live Windscribe setup. That report confirms user-observed functionality; no backend, file hash, or packet trace was supplied for independent protocol-specific verification.
- Search providers are retained and their existing tests pass. Availability of every external provider has not been certified live.
- WebTorrent PEX and container WebRTC peers are unavailable. Ordinary BitTorrent peer connections remain supported. qBittorrent receives the manually forwarded port; WebTorrent uses the next listener port to avoid a shared-socket conflict.
- Legacy history is retained in the backup. New controller lifecycle history is persisted, but a history page is deferred. `watch`, `serve`, `files`, `attach`, standalone `seed`, and the upstream updater are explicitly deferred.
- The original production npm audit reported four high-severity package entries in one WebTorrent tracker dependency chain. Release preparation replaces its `ip` slot with the exact `@bybrave/ip2@3.0.0` alias, tests address parsing/conversion, and records zero npm audit findings in [audit output](verification/dependency-audit.json). This third-party replacement and remaining container findings are documented in SECURITY.md; scanner results alone are not a security audit.

## Alpha preparation, 2026-10-05

This is a working Linux alpha, not a stable general-platform or fully audited VPN release.

- The maintainer reported that torrent transfer worked. This is user-observed evidence, separate from automated controlled-file hash verification.
- The splash and narrow-terminal fallback use Torlnk+. Color home previews at 32 and 80 columns were inspected; the existing UI controls are retained.
- Read-only live inspection confirms DROP policies on INPUT, FORWARD, and OUTPUT, tunnel egress, tunnel/gateway health, disabled IPv6, shared application namespaces, no extra administration capabilities for workers, and localhost-published management ports. See verification/network-inspection.json. The script can be rerun with `npm run verify:network -- --require-vpn`; it does not mutate routing or establish full leak-test coverage.
- `torlnk-plus doctor [--json]` checks Linux x64, Node 22.22.2+/24.15+/26+, Docker >=28, Compose >=2, rootful Docker, directory access, conditional TUN access, management ports, and effective peer listener conflicts. It does not create state or start a supervisor. Normal startup rejects failed checks; status/stop remain available. Tests cover unsupported platforms, missing runtime requirements, active-service port recognition, forwarded/listen port equality, and peer listener overflow.
- Worker npm metadata ships under ordinary container filenames, avoiding npm's package-lock exclusion. npm 12 ignores shrinkwrap, so the npm archive bundles a clean locked production dependency tree. Source releases retain package-lock.json. Source/npm archives are allowlisted, versioned, and checksummed; offline packed installation with an empty npm cache, CLI/version/doctor checks, archive/dependency validation, and building the final worker from the extracted npm tarball passed independently. A clean unpacked source installation also passed with lifecycle scripts disabled; its prebuilt CLI and nonmutating doctor work. Doctor and stopped-service status did not create state.
- The exact transitive IP replacement passes parsing/conversion regression tests. Production npm audit reports zero vulnerabilities. Container scans expose separate remaining findings; their presence must not be obscured by the npm result.
- GitHub CI now targets Linux, uses immutable action commits and read-only permissions, and includes packing/container/backend acceptance. The artifact preparation workflow does not publish automatically. Upstream invoice bots, unrelated third-party scan workflows, and funding metadata were removed from the fork's automation. Remote CI remains unrun until the fork is uploaded.
- This host runs Docker 29.7.2 on Linux x86_64. Fresh distribution installs, ARM, rootless Docker, SELinux configurations, macOS, and Windows remain unverified. Docker itself creates host networking/firewall rules; UFW/firewalld coexistence remains unverified.

Saved [acceptance results](verification/acceptance-results.json) record the current regression and isolated backend checks. Remote GitHub CI has not run. The npm registry returned no visible `torlnk-plus` package at the preparation check; this is not a reservation or permission guarantee. npm authentication and the GitHub owner remain unset. Publication stays disabled with `private: true`.

References: [npm 12 lockfile behavior](https://docs.npmjs.com/files/package-lock.json/), [Docker localhost publishing](https://docs.docker.com/engine/network/port-publishing/), and [Docker firewall behavior](https://docs.docker.com/engine/network/packet-filtering-firewalls/).

## Container scan, 2026-10-05

Trivy 0.75.0 scanned the pinned gateway/backend images and the independently built final worker/proxy images. Counts below are package-advisory instances, not unique CVEs or confirmed exploitable paths. See the [summary and image identifiers](verification/container-audit-summary.json) and its linked JSON reports. The original image scans and an intermediate worker-base scan are under `verification/historical/` and do not describe this candidate.

| Final image | Critical | High | Medium | Low | Unknown |
| --- | ---: | ---: | ---: | ---: | ---: |
| VPN gateway | 0 | 26 | 16 | 13 | 2 |
| qBittorrent | 0 | 10 | 13 | 4 | 4 |
| Application worker | 0 | 0 | 0 | 0 | 0 |
| Direct gateway | 0 | 0 | 0 | 0 | 0 |
| Stealth proxy | 0 | 0 | 2 | 0 | 1 |

The release pins Gluetun 3.41.3, qBittorrent 5.2.4, and Alpine 3.23 by immutable digest. Application workers use the pinned Node 26 Alpine base and remove npm/npx after installing locked dependencies; the final worker has no reported vulnerabilities. Stealth builds official Windscribe source commit `a7408ae39552108307b19839cfd70f1f5a39c241` using a pinned Go 1.27 builder, with a checked-in checksum patch for `x/crypto` 0.55.0 and `x/sys` 0.47.0. Its build verifies modules and uses readonly dependency resolution; its help/transport flags work. This is build evidence, not a live TLS relay or OpenVPN test.

Gluetun's remaining findings include OpenSSL packages and Go modules/runtime; qBittorrent's include PCRE2 and Python packages. No reachability assessment or security sign-off is claimed. High findings require review before approving a public alpha upload; full privacy failure coverage remains necessary for a stable release. Scan databases and upstream packages can change after this report.

## Reproduce

Follow [README.md](README.md) for installation, routing selection, and profile import. From the checkout:

```sh
npm run typecheck
npm test
npm run build
npm audit --omit=dev --audit-level=high
npm run verify:package -- --docker
npm run verify:managed
npm run verify:supervisor
npm run previews:plus
# Optional live Windscribe test; uses a protected copy and cleans its isolated stack:
# Stop any existing stack using the same WireGuard key first to avoid peer conflicts:
node --import ./scripts/native-loader.mjs --import tsx scripts/verify-vpn.ts /absolute/path/profile.conf
```

The managed qBittorrent fixture disables encryption and peer discovery to test deterministic localhost TCP peers, including an explicit-bitfield seed for missing-file repair. Production encryption defaults are unchanged. The API preference values follow the [official WebUI documentation](https://github.com/qbittorrent/qBittorrent/wiki/WebUI-API-%28qBittorrent-5.0%29).

Verification scripts create isolated state under `work/`, use separate local management ports, and remove their test containers. No test changes the original Torlnk installation or the host's Windscribe client. Images and application dependencies are pinned. Feature work was delegated; integration fixes, real transfer/lifecycle checks, and visual inspection were independently performed by the orchestrator.
