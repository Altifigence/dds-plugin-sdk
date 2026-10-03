# Publish your own plugin

Document version: 1.0.0 · Updated: 2026-10-03

Publish a versioned plugin through your own GitHub Release, a private package
registry or a private download channel. Both open-source and proprietary
plugins can use these channels when their actual licenses and dependencies
permit the intended distribution. Publication does not establish compatibility
with a DDS product host.

There is no central DDS Marketplace submission service in the public SDK.
These instructions do not announce DDS Desktop or Cloud plugin loading. Check
the installed SDK's [API](api.md), [host contract](host-contract.md) and release
notes for the capabilities and hosts actually supported by that release.

## Prepare a release

1. Choose the plugin's license and include its actual text or separately agreed
   terms reference. Include required SDK and third-party notices and any required
   corresponding-source instructions. See [LICENSING](LICENSING.md).
2. Use a unique plugin ID, publisher ID and version. Declare only implemented
   capabilities and requested permissions. Test on each advertised host; a local
   test-host run does not qualify DDS Desktop, Cloud or another production host.
3. Complete `disclosure.json` using the
   [publisher disclosure](../templates/publisher-disclosure.example.json). State
   what data the plugin uses, which backend receives it, and how users can find
   updates and contact the publisher about security.
4. List the plugin's distribution files explicitly in `dds-package.json`, then
   validate and pack them with the SDK 0.2.0 CLI described below. Inspect the
   archive; do not list credentials, private project data or files that you do
   not intend to distribute.
5. Publish the immutable versioned `.tgz`, its external `.release.json` and
   required license/source-access material through your chosen channel. The
   release metadata records the completed package and disclosure hashes without
   putting a self-referential package hash inside the archive.

Package identity and a checksum help identify the artifact. A checksum alone
does not authenticate a publisher or prove that code is safe. Hosts need their
own installation, identity, permission and isolation controls.

The packer rejects common credential/configuration paths and recognizable private
keys and provider token patterns, including when they appear in an allowed source
file. Errors do not print the detected value. This is a conservative additional
check, not a complete secret or malware scanner. Inspect your source and final
archive; obfuscated credentials and confidential implementation may evade it.

## Package format and SDK 0.2.0 CLI

SDK 0.2.0 supplies the following CLI; SDK 0.1.0 does not provide these commands.
Use an installed 0.2.0 package containing the `dds-plugin` executable.

Prepare this layout:

```text
my-plugin/
  plugin.json
  dds-package.json
  disclosure.json
  plugin.mjs
  LICENSE.plugin.txt
```

`plugin.json` is a validated SDK manifest. Manifest v2 is recommended and
declares `runtime`, `source.visibility` and `source.licenseFile`; v1 is also
accepted. Match the disclosure to its publisher, plugin ID, version, license and
source visibility. Set `entry` to the packaged executable module, for example
`./plugin.mjs`. Include the license file selected by `source.licenseFile`; a v1
package uses `LICENSE` instead of the illustrative `LICENSE.plugin.txt` above.

`dds-package.json` selects files using explicit paths relative to the plugin
root, not a directory scan or wildcard:

```json
{
  "schemaVersion": 1,
  "files": [
    "plugin.json",
    "disclosure.json",
    "plugin.mjs",
    "LICENSE.plugin.txt"
  ]
}
```

The manifest, disclosure, manifest entry and selected license file must all be
listed. The packer automatically includes `dds-package.json` and generates
`package.json`; do not list either file in `files`. The generated npm metadata
uses `type: "module"`, the manifest entry and a peer dependency on this SDK:
`>=0.2.0 <0.3.0` for manifest v2, or `>=0.1.0 <0.3.0` for manifest v1.
List `NOTICE`, third-party notices, other runtime modules, assets and source material
explicitly when they are applicable. The CLI does not determine which legal
notices or corresponding source your dependencies require. Neither visibility
choice automatically includes a source tree; TypeScript and development files
are included only when allowlisted.

Use forward-slash paths without a leading `./`, absolute paths, `..` or globs.
The packer rejects links, duplicate paths, known private configuration/key
filenames and files that change while being read. Its limits are 4 MiB per file,
10 MiB uncompressed total and at most 254 explicitly listed files. Portable
ustar paths allow a final name of at most 100 UTF-8 bytes and a directory prefix
of at most 155 bytes. The generated release filename must fit within 240 bytes,
leaving room for the metadata suffix. `validate` checks these packaging limits
before a release is written. Inspect the contents yourself as well: a filename
check cannot recognize every secret.

```sh
dds-plugin validate ./my-plugin
dds-plugin pack ./my-plugin --out ./dist
```

The [publishable plugin example](../examples/publishable-plugin/README.md) has
the complete file layout. From an SDK source checkout, the equivalent commands
are `node bin/dds-plugin.mjs validate examples/publishable-plugin` and
`node bin/dds-plugin.mjs pack examples/publishable-plugin --out ./dist`.

`validate` returns a JSON report with `pluginId`, `pluginVersion`, `publisher`,
`license`, `sourceVisibility`, `manifestSha256`, `disclosureSha256`,
`unpackedSize` and `files` (path, size and SHA-256). `pack` writes a deterministic
npm-compatible `.tgz` and external metadata named:

```text
{publisher}-{pluginId}-{pluginVersion}.tgz
{publisher}-{pluginId}-{pluginVersion}.tgz.release.json
```

The metadata contains the validation report and `artifact` (filename, size and
SHA-256). Existing output files are not overwritten. Preserve a published
version; choose a new plugin version when the artifact or disclosure changes.
Neither command executes plugin modules or package scripts. They do not upload
files, accept contracts, grant permissions or certify legal eligibility.

Node.js hosts can use the same operations directly:

```js
import { validatePluginPackage, packPlugin } from '@altifigence/dds-plugin-sdk/publishing';

const report = await validatePluginPackage('./my-plugin');
const packed = await packPlugin('./my-plugin', { out: './dist' });
```

Both open-source and proprietary plugins use this same flow. Closed-source
distribution still contains readable executable JavaScript; it need not include
additional authoring source unless the file allowlist or applicable license
requires it.

For SDK contributor verification, `npm run check` checks the SDK's contracts,
runtime tests, types, example and packed consumer. That repository check is
separate from validating and packaging your own plugin.

## Select a distribution channel

| Channel | What the publisher controls |
| --- | --- |
| GitHub Releases | Repository visibility, versioned release assets, disclosure and source access required by the license |
| Private registry | Registry access, package visibility, credentials, package retention and user license terms |
| Private download | Audience authorization, immutable artifact URLs, download access and accompanying license/disclosure |

GitHub releases can contain packaged software and supporting files. Follow
[GitHub's release documentation](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases).
For npm registry publishing, review
[npm's package access documentation](https://docs.npmjs.com/cli/v11/commands/npm-publish/)
and the registry's actual account and access requirements. These providers have
their own terms; this SDK does not create registry accounts, upload artifacts or
grant access to them.

Publish only the source that your license choices and dependencies require.
Keeping your own source private does not eliminate obligations for separately
licensed bundled components. Private repository access is not a substitute for
required source access to recipients.

## Version the publisher disclosure

The required `disclosure.json` shape is:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `1`, the packaging disclosure format |
| `publisher`, `pluginId`, `pluginVersion`, `license` | Identity and license matching `plugin.json` |
| `sourceVisibility` | `open` or `closed`, matching manifest v2's source declaration |
| `supportUrl` | Publisher-controlled HTTPS support/contact page |
| `privacyNoticeUrl` | Optional HTTPS link to the actual privacy notice |
| `dataUse` | Human-readable explanation of the data used and purpose |
| `backends` | An array of backend disclosures; use `[]` when none are used |

Each backend contains `id`, `operator`, `origin`, `purpose`, `dataCategories`
(a string array) and `retention`, plus an optional HTTPS `privacyNoticeUrl`.
Origins use HTTPS, or HTTP on a loopback host for a local service. A backend
declaration does not establish a connection, grant access or configure a
credential. Do not include credentials in a disclosure.

Do not add a `documentVersion` or the earlier nested illustrative fields to this
packaging schema. The plugin version and exact disclosure hash in the release
metadata identify the published disclosure. When a disclosure changes, publish
a new plugin release and preserve the previous package and metadata. Use the
support page for versioned detailed notices, update channels, security contact,
support expectations and the actual route for disabling/revoking access.

Replace the example's publisher, URLs and wording before distribution; the
template's example.com links are illustrative. It is not a verified publisher,
a signed declaration, an SDK manifest or a consent receipt.

If a backend is optional, distinguish the local feature from the remote feature.
Identify the operator, endpoint origin, data categories, purpose, destination
countries, transfer timing/method, retention and applicable privacy notice.
Do not treat an unspecified full workspace or remote project as an approved
transfer scope. [CONSENT](CONSENT.md) describes separate permission and data
processing records.

**EN:** This package is published by {publisher} through {channel}. It uses
{plugin license} and supports {verified hosts}. Requested permissions and any
external data processing are described in the disclosure for {plugin version},
identified by {disclosure SHA-256}. It has not been
submitted through a central DDS Marketplace service.

**KO:** 이 패키지는 {게시자}가 {배포 경로}를 통해 게시합니다. {플러그인 라이선스}가
적용되며 {검증된 호스트}를 지원합니다. 요청 권한과 외부 데이터 처리는 고지
{플러그인 버전}에 설명되어 있으며 {고지 SHA-256}으로 식별합니다. 중앙 DDS
Marketplace 서비스를 통해 제출된
패키지가 아닙니다.

## Optional publishing-service terms: inactive draft

The draft below is a possible separate agreement for a future publishing
service. No such service, submission or account acceptance is created by reading
this file. Do not show the draft as effective terms or record an acceptance until
a service and its actual terms, versioned presentation and acceptance storage
are implemented.

**EN draft:** These terms apply only when you submit a plugin to the enabled
Altifigence publishing service. They do not replace the SDK's Apache-2.0 license.
You confirm that you are authorized to publish the submitted package and have
included required license and third-party notices. You retain ownership of your
plugin. You authorize Altifigence to host, display and distribute the submitted
package to the audience you select, to operate this service. Users receive
rights under the plugin license you provide. Source disclosure is required where
an applicable license requires it. Accurately describe compatibility, permissions
and external data processing. A listing may be suspended for a documented
security issue or violation of these terms, with notice and a review route.

**KO 초안:** 이 약관은 활성화된 Altifigence 게시 서비스에 플러그인을 제출할 때
적용됩니다. SDK의 Apache-2.0 라이선스를 대체하지 않습니다. 게시자는 제출
패키지를 게시할 권한이 있고 필요한 라이선스 및 제3자 고지를 포함했음을
확인합니다. 플러그인의 소유권은 게시자에게 유지됩니다. 게시자는 서비스 운영을
위해 Altifigence가 제출 패키지를 저장·표시하고 게시자가 선택한 대상에게
배포하도록 허락합니다. 이용자의 권리는 게시자가 제공한 플러그인 라이선스에
따릅니다. 적용되는 라이선스가 요구하면 소스를 공개해야 합니다. 게시자는
호환성, 권한 및 외부 데이터 처리를 정확히 설명해야 합니다. 확인된 보안 문제나
약관 위반이 있는 게시물은 사유 안내와 검토 절차를 제공하여 일시 중단할 수
있습니다.

Future acceptance labels: `Accept publishing service terms and submit` /
`게시 서비스 약관에 동의하고 제출`. These are not SDK download consent labels.
