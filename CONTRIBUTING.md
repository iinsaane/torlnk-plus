# Contributing to Torlnk+

Torlnk+ retains upstream Torlnk attribution and uses its own command and state directory. Work in the fork repository selected for publication, not the upstream repository.

Use Node 22.22.2+, 24.15+, or 26+, with npm 12.0.2 or newer. Install dependencies with `npm ci --ignore-scripts`. Run type checking, the test suite, and production build before submitting changes. Changes to routing or backend state also need controlled managed verification; never use private user torrents for removal tests.

Use generated fixtures and isolated state for verification. Never commit VPN profiles, keys, passwords, private downloads, credentials, or runtime state. Keep all packet-capture and live transport claims limited to the conditions actually tested. The initial alpha supports Linux x86_64 with rootful Docker only.

See docs/PUBLISHING.md for release preparation and SECURITY.md for security boundaries and reporting.
