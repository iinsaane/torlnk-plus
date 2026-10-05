# Torlnk+

A Linux terminal fork of [Torlnk](https://github.com/baairon/torlink), with selectable qBittorrent and WebTorrent clients, optional Windscribe routing, settings, real piece maps, and service health. Based on upstream commit `467c0e4c6c87e1977814e9d83649968ef7d8f088`; upstream MIT attribution is retained in LICENSE and README.upstream.md.

## Install the Linux alpha

Version `0.1.0-alpha.1` supports Linux x86_64 with Node 22.22.2+, 24.15+, or 26+, rootful Docker Engine 28 or newer, and Docker Compose v2 or newer. VPN mode requires `/dev/net/tun`. Docker must be accessible to your user and download folders must be writable. The native qBittorrent installation is unused. Other architectures, macOS, Windows, rootless Docker, and SELinux configurations remain unverified.

Install the npm tarball downloaded from the release with installation scripts disabled:

```sh
npm install --global --ignore-scripts ./torlnk-plus-0.1.0-alpha.1.tgz
torlnk-plus doctor
torlnk-plus
```

Or unpack the source archive, keep its directory available, and use its prebuilt CLI:

```sh
tar -xzf torlnk-plus-0.1.0-alpha.1-source.tar.gz
cd torlnk-plus-0.1.0-alpha.1-source
npm install --global --ignore-scripts npm@12.0.2
npm ci --omit=dev --ignore-scripts
./torlnk-plus doctor
./torlnk-plus
```

`doctor --json` produces a machine-readable preflight without starting downloads or creating configuration directories. Normal startup checks required dependencies, routing requirements, directories, and management ports. `status` and `stop` remain accessible independently of startup checks. The alpha has no automatic updater; stop the background service before replacing an installed release. Back up the private state directory before upgrading. Protect that backup as you would the VPN keys.

## Build from source

For source installation and development, use npm 12.0.2 or newer with a supported Node version. npm 10 can loop while resolving this fork's pinned WebTorrent overrides. The published tarball carries bundled dependencies and does not resolve that tree again:

```sh
npm ci --ignore-scripts
npm run build
./torlnk-plus
```

The app opens on the original Torlnk-style search page with the search field focused. Routing and service health share one bottom status bar. On first run, the status bar asks you to choose a route; press **4** to open Settings and make an explicit routing choice. Select **Global routing**, press Space to choose Direct or VPN, then **S** to save. VPN requires an imported profile. **Tab** switches between Everyday and Advanced settings. Select a row with the arrows, use Enter to edit, and save with S.

To create the separate `torlnk-plus` command, optionally run `npm link` from this checkout. The included `./torlnk-plus` launcher works directly from this checkout. Otherwise use `node dist/cli.cjs` in place of `torlnk-plus` in the commands below. Keep this checkout available: the supervisor builds the managed workers from it.

## Windscribe first

Import a WireGuard profile before selecting VPN:

```sh
node dist/cli.cjs profile import /absolute/path/Windscribe-profile.conf wireguard
```

The command returns a profile ID. In Settings, choose that VPN profile and VPN routing, then save. Or:

```sh
node dist/cli.cjs vpn on PROFILE_ID
node dist/cli.cjs vpn off
```

The global **V** key also toggles VPN/direct routing intentionally, without repeated confirmation. Switching pauses and checkpoints transfers and searches, replaces the gateway namespace, then restores the active transfers. Manually paused torrents stay paused. `Protected` requires the gateway health check and an active tunnel interface. Tunnel failure changes the state to `Blocked`; it never selects Direct automatically.

WireGuard remains UDP, including on port 443. For a network that blocks UDP, import a real OpenVPN **TCP** profile whose remote endpoint uses **443**. In Advanced settings, select OpenVPN and provide its username/password if they are not inline. Password entry is masked. Certificate material must be inline; executable hooks and external file references are rejected.

Stealth uses the official [Windscribe tunnel proxy](https://github.com/Windscribe/wstunnel), type 2 TLS transport. Import an OpenVPN TCP profile plus an explicit TLS endpoint, with optional server name:

```sh
node dist/cli.cjs profile import /absolute/path/profile.ovpn stealth TLS_HOST:443 OPTIONAL_SNI
```

Stealth preserves the inner VPN CA and server certificate verification. It does not infer a TLS relay from an ordinary VPN address. TCP 443 and Stealth remain experimental pending live tests with matching profiles and credentials. Account login, subscriptions, and automatic forwarded-port renewal are deferred.

An optional manually assigned forwarded port opens that port in the VPN firewall and configures qBittorrent's listener. WebTorrent uses the next port to avoid competing for the same socket; it can make outbound peer connections. The default listen ports are 6881 and 6882. The app does not directly edit UFW, firewalld, or installed Windscribe settings. Docker creates host networking and firewall rules; coexistence with host firewall configurations remains unverified. Managed IPv6 is disabled in v1.

## Terminal controls

| Key | Action |
| --- | --- |
| Ctrl+P / : outside text editing | Open the searchable command palette; Ctrl+P works from any view or editor |
| 1 / 2 / 3 / 4 / 5 | Search / Downloads / Seeding / Settings / Health, outside an active text editor |
| / | Focus a new search or magnet, including queries beginning with a number |
| I | Import a torrent file by absolute path |
| B in Search | Override the backend for the next download |
| Enter in Search | Submit text, browse on an empty field, or download the selected result |
| Tab / Esc in Search | Move between the field and results / leave text editing; Esc again returns home |
| Enter in Downloads | Expand torrent details |
| Page Up / Page Down | Scroll expanded files and trackers |
| Delete / X in Downloads or Seeding | Remove the selected entry and stop its transfer; keep downloaded files |
| P / R / E in Downloads or Seeding | Pause or resume / recheck / export torrent |
| V | Switch global VPN/direct routing |
| Q outside text editing / Ctrl+Q anywhere | Close the interface while downloads continue |

In the command palette, type to filter, use Up/Down to select, Enter to run, and Esc or Ctrl+P to close. It provides page navigation, import, per-download client choice, VPN/reconnect controls, service refresh, and actions for the selected torrent. Disabled actions explain what is missing. Opening the palette preserves the underlying text, selection, settings edits, and detail scroll position, while suspending their shortcuts and hidden piece polling.

Removing an entry from either Downloads or Seeding removes the same torrent from the managed backend and stops its transfers; its files stay on disk. The palette exposes this as **Remove selected entry**, also searchable by **delete**. Failed removal leaves the entry visible and reports the error.

Page keys remain available while browsing Settings. Enter opens a field editor; digits then enter its value, and Enter or Esc returns to navigation. Unsaved settings survive page switches. Search fields support cursor movement, Home/End, deletion, and Ctrl+U to clear. Letter shortcuts apply outside text editing, so titles beginning with I, B, V, or Q work normally.

The default backend applies to future downloads. Existing downloads retain their original client. Torrent hashes are deduplicated across both clients. Shared transfer capacity and seeding policy are managed by the controller; each engine stores its resume state. The controller also saves up to 1000 lifecycle records in `controller/history.json`, including completion and removal dates. A history page is deferred.

Rows show transferred/total bytes, both speeds, ETA, peers, backend, state, and a numeric percentage. Expanded details include files, trackers, errors, uploaded bytes, ratio, elapsed time, destination, and verified/total pieces. Unknown values remain unknown. Piece maps use real engine data: `·` missing, `!` active beside a cell, partial/full blocks verified, and `?` unknown. Visible maps refresh every two seconds; statistics every second by default.

Routing and service health appear in a single bottom bar; page 5 shows individual service details. It reports supervisor, controller, gateway, search, qBittorrent, and WebTorrent independently, including last check and last successful response. Provider-specific search failures are reported with search results.

`node dist/cli.cjs start` explicitly starts the background service without opening the interface. `node dist/cli.cjs status` prints the current state without starting a stopped service. `node dist/cli.cjs stop` is the separate action that stops the background service and containers. Closing the terminal alone keeps transfers running.

## Files and isolation

Default state is `$XDG_DATA_HOME/torlnk-plus` or `~/.local/share/torlnk-plus`; override with `TORLNK_PLUS_STATE_DIR`. Configuration saves are atomic. Profile files and management credentials are owner-only, within a private state directory. Private VPN profiles and supervisor credentials are not mounted into network workers.

The host supervisor manages five containers: gateway, controller, search, WebTorrent, qBittorrent. Workers share the gateway network namespace, use your file UID/GID, and mount selected download folders and their own state. Only the VPN gateway receives NET_ADMIN and the TUN device; DAC_OVERRIDE lets it read the private read-only configuration. Images are pinned by digest and dependencies by lockfile. The controller and qBittorrent management ports bind to localhost and require authentication; internal search/WebTorrent RPCs also require authentication. No Docker socket is mounted into workers.

Management defaults: supervisor 9161, controller 9162, qBittorrent 8080. If occupied, set `TORLNK_PLUS_PORT`, `TORLNK_PLUS_WORKER_PORT`, and `TORLNK_PLUS_QBIT_PORT` before startup, and use the same values on subsequent CLI calls. qBittorrent's internal/published WebUI ports must match for its Host validation.

WebTorrent PEX is currently unsupported and disabled in its settings. Container WebRTC peers are disabled; ordinary TCP/UDP BitTorrent peers are supported. Extra trackers and network-affecting engine settings recreate workers when saved. Closing and reopening the interface is sufficient for other persisted display changes.

## Legacy import

Stop upstream Torlnk before copying its records so they are consistent. Import into an empty fork state directory **before starting this fork for the first time**:

```sh
node dist/cli.cjs migrate "$HOME/.config/torlink" "$HOME/.local/share/torlink"
```

The importer backs up the source configuration, queue, history, seed records, and metadata under `legacy-backup`, without changing those source files. It copies records into the fork and marks their backend WebTorrent. Existing download folders remain their destinations and are mounted explicitly. Native piece verification runs before WebTorrent resumes data transfer. Interrupted migration can be retried with the same source paths. Import into unrelated nonempty state is refused. History remains available in the backup; v1 shows current torrent records in its download list.

The fork has no upstream updater. `watch`, `serve`, `files`, and `attach` explain that they are deferred. Seeding is available on page 3; the former standalone `seed` mode is deferred too.

## Verify

```sh
npm run typecheck
npm test
npm run verify:managed
npm run verify:supervisor
# Optional live test, using your own profile:
# Stop other stacks using the same WireGuard key before testing:
node --import ./scripts/native-loader.mjs --import tsx scripts/verify-vpn.ts /absolute/path/profile.conf
npm run previews:plus
```

The managed verifier generates controlled data, transfers it through qBittorrent, checks SHA-256, and removes its isolated test containers. The automated WebTorrent suite performs real peer transfers, pause/restart, and corrupted-file repair. The supervisor verifier tests mixed clients, duplicates, routing failure/recovery, service health, and background lifetime. See [VERIFICATION.md](VERIFICATION.md) for the exact passed and unverified checks. UI captures are in `preview/plus`, including the home screen, command palette, search results, downloads, seeding, details, settings, and health at narrow and standard sizes. The redesign adapts upstream Torlnk logo, panel, and color components with the Torlnk+ wordmark; focus and layout behavior were also informed by [Textual input guidance](https://textual.textualize.io/guide/input/) and [Ratatui layout guidance](https://ratatui.rs/concepts/layout/).


## Release evidence and preparation

This is an alpha with documented limitations, not a general-platform or fully audited privacy release. The maintainer reported a successful local torrent transfer on 2026-10-04. That report is distinguished from automated controlled-file hash verification in VERIFICATION.md.

From a development checkout, inspect the running managed network without changing its routing:

```sh
npm run verify:network -- --json
# Require the running stack to be in VPN mode:
npm run verify:network -- --require-vpn
```

The inspection checks live gateway rule policies, tunnel health, shared worker namespaces, management bindings, and disabled IPv6. It does not replace packet captures across startup, crashes, restarts, and mode changes. Direct mode is identified explicitly and does not claim VPN protection.

Run `npm run verify:package -- --docker` to install and test a temporary packed release and build its worker image. `npm run release:package` creates versioned source/npm tarballs and checksums under `release/`. GitHub workflows test the supported Linux target and prepare downloadable artifacts; they do not publish automatically. See [publishing instructions](docs/PUBLISHING.md), [security limitations](SECURITY.md), and [verification evidence](VERIFICATION.md).
