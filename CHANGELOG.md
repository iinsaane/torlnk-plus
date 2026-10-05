# Changelog

## 0.1.0-alpha.1

First Linux x86_64 alpha of Torlnk+, based on Torlnk commit `467c0e4c6c87e1977814e9d83649968ef7d8f088`.

- Select qBittorrent or WebTorrent per download, with hash deduplication and background transfers.
- Import Windscribe WireGuard and generic VPN profiles; intentionally switch global VPN/direct routing. TCP 443 and Stealth remain experimental.
- Keep the search-first terminal layout, with one routing/service status bar, a command palette, keyboard settings, and six service health indicators.
- Show transfer metrics, file/tracker details, and real fragmented piece progress.
- Remove entries from Downloads or Seeding while keeping downloaded files.
- Import legacy records into separate fork state with a backup and verification before resume.
- Package worker dependency metadata separately so the npm tarball can build managed containers.
- Add a nonmutating runtime doctor and read-only live firewall inspection.
- Update pinned container versions, remove worker installation tooling, and patch the Stealth dependency graph; remaining upstream advisories are recorded.

See SECURITY.md and VERIFICATION.md for limitations and release evidence. Linux x86_64 with rootful Docker is the only supported alpha target. ARM, macOS, Windows, rootless Docker, and full failure-scenario leak coverage remain unverified. There is no automatic updater in this release.
