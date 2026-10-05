# SDK 1.0 release contents and acceptance

1.0.0 is the stable public SDK API release. Its source tag and immutable tarball,
SHA256SUMS, exact CI commit and acceptance receipt are on the GitHub release.
The release has no runtime npm dependencies. LICENSE and NOTICE cover this SDK;
plugin publishers retain responsibility for their own and third-party terms.

Security audit and vulnerability validation remain **pending** under the owner's
2026-10-05 deferral (DDS-243). This release does not claim audit passage or resolution
of unvalidated review candidates. Functional delivery continues under that decision.

## Included API

The complete machine-readable inventory is [API_SUPPORT.json](../API_SUPPORT.json).
It contains 38 exported paths, runtime names, declaration names/digests and each
environment/stability classification. Declarations and 86 versioned JSON schemas
ship beside the implementation. The package allowlist is [PUBLIC_SURFACE.json](../PUBLIC_SURFACE.json).

Included: plugin/manifest contracts; themes; user-owned workspaces and tools;
commands and durable jobs/history; conditional files, project query/watch and
reviewed edits; stored text/binary results; browser/Node upload/download queues;
language assistance and semantic display; settings, secret references, localization;
six development templates, generation/testing/diagnostics; 18 conformance profiles.
OPFS checkpoint recovery remains experimental and requires the documented Worker,
Web Locks and actual browser acceptance. Optional features require discovery and grants.

The functional release matrix covers Windows/Linux and Node 22.23.3/24.21.0, with
TypeScript 5.9.3. RC browser proof used Chromium 154 on Windows: 12 profiles supported,
six Node-only profiles unsupported and zero failed. The GA receipt identifies fresh
consumer checks and any byte-identical or unchanged-code evidence reused from RC.
The [RC report](RC_ACCEPTANCE.md) describes fault fixtures and the measured four-profile
performance guard; sampled process memory and logical I/O are not whole-OS guarantees.

## Install, migrate and recover

Install the exact public SDK archive with lifecycle scripts disabled, verify its
release hash, run the [conformance example](CONFORMANCE.md), and exercise your plugin.
Use the [official installation guide](https://docs.altifigence.com/developers/plugin-sdk/)
and [development guide](https://docs.altifigence.com/developers/plugin-sdk-development/).
The six templates include tests, types, doctor, generation and pack/verify scripts.

The stable plugin peer is `>=1.0.0 <2.0.0`. RC1 and legacy archives retain their
original peers; publishing a newly validated plugin version changes installation
eligibility. Old/new clients and hosts still need common optional contracts.
Use [support and migration](SUPPORT_POLICY.md) for runtime dates, deprecation and
maintenance windows. Report defects through GitHub Issues; use the private report
route in [SECURITY.md](../SECURITY.md) for vulnerabilities.

To return to an earlier SDK, stop owned work, retain the prior immutable SDK/plugin
archives and configuration export, then explicitly select compatible versions.
Review current permissions and make a fresh connection. Durable result recovery is
readback-only; old output references are not fresh authority. External effects and
incompatible application settings are not automatically undone. Test the downgrade
against the formats and optional features actually used; the SDK does not change
installed plugins or settings automatically.

## Subsequent SDK work

1.1 is planned to add reviewed dependency bundles, detached provenance verification
and explicitly approved updates. 1.2 is planned to add workflow DAGs, incremental
caching, external-tool streams and LSP bridging. Neither is claimed in this tarball.
DDS UI/Engine/Cloud/Marketplace integration and native installers are separate releases.
