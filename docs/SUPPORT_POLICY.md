# SDK 1.x support and migration

`1.0.0` is the stable SDK line. Pin the installed archive; newly packed plugins
use `>=1.0.0 <2.0.0`. The policy below applies to this line. Security audit and
vulnerability validation remain pending under the owner's 2026-10-05 deferral;
stable API status does not constitute security or DDS product acceptance.

## Public API and optional features

[API_SUPPORT.json](../API_SUPPORT.json) inventories every package export, its
runtime names, public declarations, declaration digest, availability and stability.
`npm run api:check` detects changes to that inventory. Public declarations and
documented wire/storage contracts define behavior; file names under `src/` that
are not package exports are implementation details and must not be imported.

Stable exports follow [SemVer 2](https://semver.org/): fixes use patch releases,
compatible additions and deprecations use minor releases, incompatible stable API
changes require a new major. Security fixes can reject inputs already outside the
documented permission/path/resource contract. Unknown contract fields, capabilities
and versions remain rejected; do not equate protocol v1 with support for every
optional method. Discover each optional capability and retain its bounds. A failed
discovery, malformed response or denied permission is not an unsupported response.

`artifact-resume-browser` remains **experimental**: its Worker, OPFS sync access
and Web Locks profile is browser dependent. Pin an exact SDK/browser version;
experimental changes are announced in minor-release notes and require fresh
acceptance. Its presence is not a cross-browser compatibility claim. Other browser
ports also require their documented capability and permission checks.

No stable API is deprecated in 1.0.0. Future deprecations appear in declarations,
the changelog and migration guide for at least two minor releases and six months
before removal in a new major. Runtime execution does not emit unsolicited warning
logs or change grants. A security emergency is documented explicitly.

## Versions and maintenance

Stable 1.0 plugin packages use `>=1.0.0 <2.0.0`; a plugin using a later minor's new API must
declare that higher minimum. The packer records its release's supported range;
it does not infer compatible source or widen an existing archive. RC packages
require an explicit prerelease peer. Old archives retain their original peer
metadata when verified. Revalidate and repack a new plugin version to change it.

The latest stable 1.x minor receives ordinary fixes. The immediately preceding
minor remains eligible for critical security fixes for 90 days after its successor
is published, within a supported Node runtime. Preview and RC releases are replaced
by their successor and do not receive a separate maintenance branch. No commercial
response-time or availability guarantee is supplied by this open-source SDK.

Windows and Linux on currently patched Node 22 and 24 are the tested server/CLI
families. Node 22 support ends on **2027-04-30**, and Node 24 on **2028-04-30**,
following the [Node release schedule](https://github.com/nodejs/Release/blob/main/schedule.json).
Supported families and end dates are reviewed for each release; a planned runtime
removal is announced in advance and made in a major release, except after upstream
security support ends. Node 20/23/25/26, macOS, alternative JavaScript runtimes and
other browser/storage combinations have no acceptance claim in this release.
Exact tested patch versions, OS images and browser builds are release evidence,
not inferred from the broad `engines` field. Type declarations are checked with
TypeScript 5.9.3; there are no SDK runtime npm dependencies.

## From 0.13 and earlier

1. Install the exact RC or GA SDK archive, inspect its SHA-256 and retain its source
   release URL. A digest confirms byte identity; it does not authenticate a plugin
   publisher or certify code safety.
2. Run the [conformance suite](CONFORMANCE.md) and existing plugin tests in a fresh
   consumer. Review every unsupported feature before configuring a production host.
3. Regenerate declarations only after reviewing `generate --dry-run`; edited
   generated files require explicit conflict resolution. Update plugin peer metadata
   by publishing a newly reviewed plugin version, not editing an existing archive.
4. Upgrade clients and hosts independently and test their common features. Public
   0.3.2 through 0.13 archives are legacy **interoperability test inputs**. They are
   not maintained SDK lines and are not install-compatible with a newly packed 1.x
   plugin. No new capability is silently emulated through broader file or command APIs.
5. Retain workspace/store identity, request a fresh connection and current grants
   after restart, and use new generation-bound result references. Recovery reads
   committed state; a retry requires an explicit new job ID and reviewed input.

SDK, workspace protocol, manifest, plugin, host, persisted schema and DDS product
versions are separate. This policy covers the public SDK and documented user-owned
host path. A passing SDK suite does not prove DDS UI, Engine, Cloud or Store acceptance.
