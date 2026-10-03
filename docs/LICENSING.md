# SDK and plugin licensing

Document version: 1.0.0 · Updated: 2026-10-03

The SDK and included examples use [Apache License 2.0](../LICENSE). Downloading,
using or redistributing them does not require a separate proprietary SDK
agreement or a publishing-service account. A host's permission prompts and a
publisher's plugin license are separate from the SDK license.

## Choose a license for your plugin

You may license code you own as open source or under proprietary terms, subject
to the code and dependencies you use. Preserve Apache's required license,
modification notices and applicable NOTICE material when redistributing SDK
material. Apache does not grant trademark rights. See the authoritative
[Apache-2.0 text, sections 4 and 6](https://www.apache.org/licenses/LICENSE-2.0).

Choose and distribute an actual license document, not just a manifest label:

| Distribution | Publisher material to include |
| --- | --- |
| Open-source plugin | The selected license text, attribution and required source/access instructions |
| Proprietary plugin | The actual license or reference to separately agreed terms, plus notices for separately licensed components |
| Plugin using third-party code or tools | The required third-party notices and applicable source/access obligations, regardless of the plugin's own license |

Independent plugin distribution is distinct from contributing code to the SDK
repository. Contributions intentionally submitted to this repository follow
[CONTRIBUTING](../CONTRIBUTING.md) and Apache-2.0 section 5 unless separately
agreed. Publishing your own plugin does not itself contribute that code here.

## License identifiers and files

Manifest v2 in SDK 0.2.0 accepts SPDX-style expression syntax, including `AND`,
`OR`, `WITH`, parentheses and custom `LicenseRef` references. This is syntax
validation, not validation against a complete SPDX license catalog or a verdict
on legal eligibility. Manifest v1 remains accepted and retains its single-token
license format. A custom identifier such as
`LicenseRef-ExampleCo-Proprietary` refers to an actual publisher-supplied license;
the identifier does not establish distribution rights. The
[SPDX expression specification](https://spdx.github.io/spdx-spec/v2.3/SPDX-license-expressions/)
describes custom references and compound expressions.

For manifest v2, set `source.visibility` to `open` or `closed` and identify the
actual bundled license with `source.licenseFile`. The publishing disclosure's
license and source visibility must match the manifest. Source visibility is a
publisher declaration, not proof of license compliance or a code access control.
For manifest v1, the packaging convention requires a bundled `LICENSE` file.

Both visibility choices use the same packaging commands. A proprietary license
does not conceal executable JavaScript: recipients can read the `.mjs` files
needed to run a plugin. Additional TypeScript, source maps and development files
are included only if listed in the package's explicit file allowlist. Choose
that list according to the actual license and distribution obligations.

The npm `package.json` field is separate from the SDK manifest. npm supports a
custom license reference such as `"license": "SEE LICENSE IN LICENSE.plugin.txt"`
when that file is included in the package. `"UNLICENSED"` does not grant users
rights to a commercial closed-source plugin; `"private": true` prevents npm
publication and can protect a package intended for another private channel.
See [npm's license field documentation](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/).

The SDK packer generates its own `package.json`. It uses `SEE LICENSE IN` for a
manifest expression containing `LicenseRef-`, pointing to the packaged license
file. Do not put an author-written `package.json` in its file allowlist. This
metadata conversion is not a license compatibility or eligibility decision.

[LICENSE.proprietary.example.txt](../templates/LICENSE.proprietary.example.txt)
is a short rights-reservation example for publisher-owned material. It is not a
complete enterprise license, an executed agreement or a guarantee of legal
suitability. Replace its placeholders and identify the actual applicable terms
before distributing a proprietary plugin.

## Copyleft dependencies and external backends

The SDK's Apache license does not remove conditions imposed by other components.
GPL object-code distribution can require corresponding source and appropriate
source-access instructions. Whether a plugin and another program form one work
depends on their interaction, not only whether they use a process boundary or
HTTP. See [GPL-3.0 section 6](https://www.gnu.org/licenses/gpl-3.0.html) and the
[GNU FAQ on plugins and combined programs](https://www.gnu.org/licenses/gpl-faq.en.html).

For a modified AGPL program with remote network interaction, review the source
offer requirements in [AGPL-3.0 section 13](https://www.gnu.org/licenses/agpl-3.0.en.html).
This does not mean every independent service or every plugin must disclose all
its code. Evaluate the actual component license, modifications and integration.

Launching a user's separately installed tool, linking its code, bundling its
binary and operating a remote service are different distribution arrangements.
Identify which one your plugin uses and comply with that component's terms.
Open-source software licenses do not authorize a third-party hosted service,
credential use, trademark use or transfer of project data.

## User-facing license notice

**EN:** The SDK and its examples use Apache License 2.0. This plugin uses
{plugin license}. SDK licensing does not grant the plugin permissions to access
your workspace or send data to a backend. See the plugin license and listed
component notices before use.

**KO:** SDK와 포함된 예제에는 Apache License 2.0이 적용됩니다. 이 플러그인에는
{플러그인 라이선스}가 적용됩니다. SDK 라이선스는 플러그인에 작업공간 접근이나
백엔드 데이터 전송 권한을 부여하지 않습니다. 이용 전에 플러그인 라이선스와
표시된 구성요소 고지를 확인하세요.

The Korean summary explains the separation of rights and permissions; it does
not replace the original Apache license text. Continue with
[publishing](PUBLISHING.md) and [permissions and consent](CONSENT.md).
