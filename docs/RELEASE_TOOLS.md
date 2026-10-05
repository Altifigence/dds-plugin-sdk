# Bundles, provenance and reviewed updates

SDK 1.1 adds five Node-only entry points: `/bundles`, `/provenance`, `/updates`,
`/updates-node` and `/upstream`. They are optional tools for a user-owned host.
They do not operate a registry, schedule checks, publish releases or grant plugin
permissions. Existing unsigned DDS `.tgz` archives still use `/publishing`.

Run the complete working example after installing the SDK:

```sh
node node_modules/@altifigence/dds-plugin-sdk/examples/release-tools/run.mjs
```

The example creates disposable files, an ephemeral signing key in memory and a
loopback HTTP fixture. It installs and executes an SDK-authored plugin with a
real dependency, approves an update while an old command runs, rolls back, and
reads its durable journal. It never contacts an external registry.

## Deterministic offline bundles

`lockBundleDependency` accepts a reviewed file tree, exact version, HTTPS source,
entry point, module type, exact dependency map, license/NOTICE paths and an
explicit redistribution decision. Files use canonical base64. The dependency
digest covers all these values and file contents under DDS canonical JSON v1.
It is a digest of the reviewed tree, not a claim that an upstream tarball has the
same hash. Keep the original upstream archive digest in your review evidence.

`createPluginBundle({plugin, dependencies, packages})` embeds a DDS archive,
its release metadata and expected hash, plus the locked dependency graph and a
deterministic CycloneDX 1.6 SBOM. Exact package versions are global within a
bundle; cycles, conflicting versions, missing packages and unreachable packages
are rejected. This format supports reviewed ESM/CommonJS trees. Native addons,
postinstall downloads, arbitrary npm metadata, dependency export maps and
unreviewed npm dependency resolution are outside this format.

`verifyPluginBundle(bytes, {expectedSha256})` checks a bounded byte snapshot and
returns inventory, source, licenses, SBOM and digests. Limits are 32 dependencies,
1,024 expanded files, 4 MiB per dependency file, 32 MiB expanded data and 48 MiB
encoded bundle. The existing root archive verifier has its own smaller limits.
Paths, case collisions, regular file types and file/directory conflicts are
checked before installation. The bundle is canonical UTF-8 JSON: sorted object
keys, preserved array order, finite JSON numbers and no duplicate object keys.
Reviewed input bytes are preserved; timestamps, absolute paths and platform
archive metadata are not generated into dependency files.

```js
import {verifyPluginBundle, installPluginBundle} from '@altifigence/dds-plugin-sdk/bundles';

const receipt = verifyPluginBundle(bytes, {expectedSha256: approvedHash});
await installPluginBundle(bytes, {
  destination: newDirectory,
  expectedSha256: receipt.sha256,
  approved: true,
});
```

Installation requires a new directory under an operator-controlled parent. It
does not invoke npm, run scripts, fetch files or execute the plugin. A failed
installation is reported with the destination and left for inspection. The
owning process must exclude concurrent filesystem writers; this is not an OS
sandbox. The SDK itself remains a separate host dependency. Dependencies gain no
grants from the bundle and receive no additional permissions from the installer.

## Detached provenance and operator trust

`createProvenanceStatement` binds a bundle's exact name/version/SHA-256 to its
publisher, source revision, issue time and expiry. `signPluginProvenance` uses a
caller-owned Ed25519 `KeyObject`. No private key is bundled with the SDK. The
signed bytes are `DDS-PROVENANCE-V1\n` followed by canonical statement JSON.
`canonicalProvenancePayload` lets another signer reproduce these bytes.

`verifyPluginProvenance(bytes, envelope, policy)` takes operator-selected public
keys and publisher bindings, explicit current time, key validity/revocation,
revocation evidence time and maximum age, offline policy and unsigned policy.
Maximum accepted clock skew is five minutes; maximum revocation evidence age is
30 days. The chosen policy can be stricter. Offline verification uses supplied
evidence; it never obtains fresh revocation information itself. Both online and
offline verification reject evidence outside the supplied freshness budget.

The receipt separates `checksum`, `signature`, `publisher`, `policy` and
`executionAuthorized: false`. A valid signature does not establish code safety,
approval to execute, grants, a sandbox or DDS product signing authority. A new
key becomes trusted only when the operator adds it. Rotation can overlap two
explicit roots; expiry and revocation are checked again before activation.
`envelope: null` requires `allowUnsigned: true` and still reports unsigned and
unverified publisher. It does not manufacture provenance for older releases.

## Review, approve, activate and recover

`createPluginUpdatePlan` binds old/new bundle bytes, version, API/capabilities,
grants, dependency sources/digests, declared tools, licenses, settings hashes,
migration identity, signing envelope and key. `parsePluginUpdatePlan` checks its
version and canonical digest. Each descriptor comes from the verified bundle.

`createPluginUpdateController` owns a currently authorized host, a settings
snapshot and one journal. Its operator-supplied `getPolicy` returns fresh trust
evidence; `prepare` creates a separate candidate host after explicit approval.
The host ports execute trusted code and must enforce their granted authority.

1. `stage` verifies and snapshots candidate bytes and next settings.
2. Review the returned plan, then `approve` its exact digest, grants and key ID.
3. `activate` rechecks bytes, current settings and trust before and after preparing
   the candidate. It records the change with an exact journal revision.
4. `execute` retains the host/settings snapshot it began with and returns the
   plugin bundle hash with the result. Under `wait`, active jobs defer the switch;
   `retain-old` keeps the old host until its jobs settle. Neither policy silently
   cancels jobs. Pass a caller-owned AbortSignal for explicit cancellation.

Settings replacement invalidates staged approval. Preparation/migration failure
keeps the old host and settings. Concurrent updates fail with a conflict/busy
result. Preparation code can have external effects; neither failed activation
nor rollback undoes external writes, emails, processes or network requests.
The migration's `reversible` flag is review metadata, not an automatic undo
promise. Rollback stages the previous bundle/settings as another update and
requires fresh policy and approval.

The Node journal lives in a dedicated directory outside the workspace. It has
one writer, append-only digest-checked records, exact revision CAS, file sync and
bounded storage (256 records, 128 KiB per envelope, 8 MiB total). Archive it under
operator control before starting a new journal at the limit. It does not promise
cross-process host/settings/filesystem transactions or power-loss durability on
every platform. A crash in `preparing`, an ambiguous write acknowledgement or an
unreadable tail requires host readback. `inspectNodeUpdateJournal` reports stored
state without replay; `reconcilePluginUpdateJournal` records an explicit,
approved readback of a known old/new digest and settings hash. A corrupt tail
must be inspected and repaired by the operator. `recoverStaleLock: true` only
recovers a same-machine writer that is demonstrably no longer alive. It never
breaks a live or unknown writer lock.

## Upstream candidates

`fetchUpstreamArtifact` runs only when called with `enabled: true`, an exact
source/version/digest, exact URL allowlist, offline flag, byte limit and deadline.
Redirect targets need their own allowlist entries. It sends no cookies or auth
headers, performs no implicit retry and returns distinct offline, unavailable,
unverified, digest-mismatch and verified results with observation time. Loopback
HTTP requires a separate explicit fixture option. A changed tag/digest requires
new review; it is not accepted as the old release.

An adapter can publish a reviewed `upstream-manifest` with API names, exact source
revision, full license/NOTICE and file digests. `inspectUpstreamManifest` binds
that metadata to downloaded bytes. It does not inspect arbitrary upstream code
or infer license permissions. `createUpstreamCandidate` compares API/file/license
changes against an exact supported-version matrix and a developer-owned
functional check. A matrix match without that check remains `unverified`;
missing required APIs are `unsupported`. Even `supported` yields review data and
an expected-before/replacement source patch, with `reviewRequired: true` and no
automatic actions. The host owns test execution and its cancellation budget.

## Release evidence and limits

The package includes TypeScript declarations and versioned JSON Schemas for the
new contracts, plus functional tests for the reviewed input and lifecycle
rules. The release runs independent packed consumers and Windows/Linux × Node
22/24 CI. New tools are Node-only; existing browser functionality is unchanged.
Security audit and vulnerability validation remain deferred. Passing these
functional contracts does not complete that separate review.

References: [Node crypto sign/verify](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptosignalgorithm-data-key-callback),
[CycloneDX 1.6 schema](https://cyclonedx.org/schema/bom-1.6.schema.json).
