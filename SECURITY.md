# Security and alpha limits

WebTorrent 2.8.5 brings `ip` through `torrent-discovery` and `bittorrent-tracker`. The upstream `ip@2.0.1` package is covered by [GHSA-2p57-rm9w-gvfp](https://github.com/advisories/GHSA-2p57-rm9w-gvfp): its address classification can treat non-canonical private addresses as public. This release pins the transitive `ip` slot to `@bybrave/ip2@3.0.0` with an npm alias. The replacement parses addresses before classification and rejects ambiguous spellings. Regression tests cover the IPv4 and IPv6 buffer-formatting API used by the tracker and the advisory's non-canonical input examples.

The replacement is a third-party maintained fork of `indutny/node-ip`, not an upstream WebTorrent package. Its npm tarball is pinned by integrity in `package-lock.json`; the package has no install lifecycle scripts or runtime dependencies. We reviewed its package entry points and documented conversion API. Regression tests cover IPv4/IPv6 buffer conversion and representative private/public classifications. The tracker’s server-only UDP parser has a numeric `toString` call which is outside the documented buffer API and is not covered as a supported path. npm registry metadata supplies an integrity signature; it did not advertise a provenance attestation when reviewed.

Run `npm audit --omit=dev --audit-level=high` after dependency changes. The saved report in `verification/dependency-audit.json` records the current production dependency audit. A clean scanner result does not establish that every dependency is safe; keep the lockfile and compatibility tests current.


## Runtime boundaries

The alpha supports Linux x86_64 with rootful Docker Engine 28 or newer. Only the VPN gateway receives network administration privileges and TUN access. Application workers share that gateway network namespace. Management ports bind to localhost and require credentials. VPN mode never selects Direct after a failure. IPv6 is disabled in the managed network.

These controls are not a complete privacy audit. Live rule inspection and limited tunnel-loss probes pass, but full packet captures across startup, every component crash, restart, and mode changes remain outstanding. OpenVPN TCP 443 and Windscribe Stealth are experimental until live protocol-specific checks pass. Windscribe WireGuard on port 443 is still UDP.

Docker access is privileged access to the machine. The application does not directly configure UFW or firewalld, while Docker itself adds host networking/firewall rules. Host firewall coexistence, rootless Docker, SELinux, ARM, Windows, and macOS remain unverified. The doctor checks required runtime conditions; it does not prove firewall exceptions or container images safe.

## Private files and diagnostics

Keep VPN profiles, private keys, OpenVPN passwords, management credentials, state backups, and traffic captures outside the repository and release archives. Imported/runtime profile files and credentials have owner-only permissions. The supplied original profile is preserved. Profile hooks and external file references are rejected.

Release archives are built from allowlists and checked for private paths. Public UI previews use synthetic fixtures. Do not paste raw state files, full Docker inspect output, profile contents, or captured peer traffic into public issue reports. Supply the version, a redacted doctor report, the action that failed, and non-sensitive error text.

## Container advisories

The container scan discovered high and critical advisories in the original Gluetun 3.40.0 pin. Release preparation updates the oldest base images, removes the installed worker npm toolchain, patches the pinned Stealth module graph with exact checksums, and records final scans in verification/container-audit-summary.json. The final worker and Stealth image have no reported high or critical findings; Gluetun still has 26 high and qBittorrent 10 high package-advisory instances. Remaining container findings require review; a zero npm audit result covers the npm dependency graph only. See VERIFICATION.md for exact current counts and tested image versions. Reachability of each scanner finding has not been established.

## Reporting

Publication destinations and a private security reporting channel are pending. Until a private channel is configured for the fork, do not create public issues containing credentials, private profiles, or exploit details. Security reports for this fork must not be sent to upstream Torlnk's issue tracker. Stable-release privacy and platform claims require the outstanding validation, even after alpha packaging passes.
