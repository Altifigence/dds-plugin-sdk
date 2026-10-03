# Permissions, notices and consent records

Document version: 1.0.0 · Updated: 2026-10-03

Keep a host permission grant, acknowledgement of an information notice,
acceptance of actual plugin license terms, optional personal-data consent and
acceptance of an enabled publishing service's terms separate. None changes the
SDK's Apache-2.0 license. Merely reading this document or downloading the SDK
creates no acceptance record.

SDK 0.2.0 provides the local notice and receipt helpers described below. They
validate caller-supplied data; they do not present a dialog, authenticate a user,
store an account acceptance or create a legal signature. This does not mean
DDS Desktop, Cloud or a central Marketplace provides the described dialogs,
storage or enforcement. The trusted in-process test host is not a sandbox;
see the [host contract](host-contract.md).

SDK 0.2.0's package disclosure and `.release.json` identify publisher-provided
information and artifact hashes. Running `dds-plugin validate` or `dds-plugin
pack` does not record any of these decisions. A DDS native technical
approval, if offered by a product host, is an access decision and must not be
relabeled as optional personal-data consent.

## Show the scope before enabling a plugin

Show the publisher, plugin ID, version, artifact identity, actual supported host,
workspace/project scope, requested capabilities and enforceable permissions.
Present a publisher-supplied license separately from access permissions. The
manifest declares requests; it does not grant them.

**EN permission prompt:** Enable {plugin}@{version} for {workspace} and allow
only the permissions listed below. You can disable the plugin or revoke these
permissions in {settings location}.

**KO 권한 안내:** {workspace}에서 {plugin}@{version}을 활성화하고 아래에 표시된
권한만 허용합니다. {설정 위치}에서 플러그인을 비활성화하거나 권한을 철회할 수
있습니다.

Button: `Allow listed permissions` / `표시된 권한 허용`.

Where an actual plugin license requires a separate acceptance, present its
resolved terms as a distinct choice. Do not use this as an extra Apache SDK
download agreement.

**EN plugin license acceptance:** I accept {actual plugin terms and version}
for {plugin}@{version}. This choice does not grant workspace permissions or
personal-data transfer consent.

**KO 플러그인 이용조건 동의:** {plugin}@{version}에 적용되는 {실제 플러그인
이용조건 및 버전}에 동의합니다. 이 선택은 작업공간 권한 허용이나 개인정보
전송 동의가 아닙니다.

Implement the stated revocation route before using this wording. A declarative
theme that only supplies validated visual tokens should not request document,
backend, process or credential access. Other capabilities must state their actual
resource scope. Do not preselect a full workspace or a remote project as a data
source; that broader transfer scope needs an explicit product decision and user
review. No permission named in this guide expands the installed SDK contract.

## Explain external data processing separately

Before connecting a backend, show the actual operator and contact, endpoint
origin, transmitted data categories, purpose, destination countries, timing and
method, retention, privacy notice and effects of declining. Distinguish local
processing, transmission to a user's own backend, and processing by another
service. An endpoint URL alone does not identify the processor or data location.

A technical `connect` grant is not automatically personal-data consent or a
lawful basis for processing. Select the actual legal basis for the actual data
and relationship. Where processing does not rely on consent, present the required
notice as information; do not fabricate a consent event.

**EN information acknowledgement:** I have read disclosure {version}, which
explains {backend operator}, the data used, its purpose and retention. This
acknowledgement does not grant plugin permissions or record personal-data consent.

**KO 정보고지 확인:** 백엔드 운영자 {운영자}, 사용하는 데이터, 목적과 보유기간을
설명하는 고지 {버전}을 확인했습니다. 이 확인은 플러그인 권한 허용이나 개인정보
처리 동의를 기록하지 않습니다.

Acknowledgement is optional unless an actual host/service requirement makes it
necessary; reading a notice must not silently enable a backend.

### Personal-data consent when that is the selected legal basis

**EN separate optional consent:** I consent to providing {personal-data
categories} to {recipient and contact} for {purpose}, retained for {period}.
I may decline; {specific effect of declining}. Withdrawal: {method}.

**KO 별도 선택 동의:** {개인정보 항목}을 {수령자 명칭 및 연락처}에게 {목적}으로
제공하고 {기간} 동안 보유·이용하는 데 동의합니다. 동의를 거부할 수 있으며,
거부 시 {구체적인 영향}이 있습니다. 철회 방법: {방법}.

For consent-based overseas transfer, use a distinct choice that also discloses
the destination countries, transfer timing/method and how to refuse the transfer.
Do not replace factual recipients and locations with "all providers".

**EN overseas-transfer consent:** I separately consent to transferring
{personal-data categories} to {recipient and contact} in {countries} by
{method}, at {timing}, for {purpose}, retained for {period}. I can refuse by
{procedure}; {specific effect}. Withdrawal: {method}.

**KO 국외 이전 별도 동의:** {개인정보 항목}을 {국가}의 {수령자 명칭 및 연락처}에게
{시기}에 {방법}으로 이전하여 {목적}으로 {기간} 동안 보유·이용하는 데 별도로
동의합니다. {절차}로 거부할 수 있으며 {구체적인 영향}이 있습니다. 철회 방법:
{방법}.

These are placeholder templates, not a determination that consent is required
for every backend. Under the Korean Personal Information Protection Act,
consent matters must be distinguished, and information processed on another
basis must be separately explained. Consent-based provision and overseas
transfer have specified disclosure requirements and changes require renewed
consent. Overseas transfer also has bases other than consent. See
[section 22](https://www.law.go.kr/lsLawLinkInfo.do?chrClsCd=010202&lsJoLnkSeq=900078945),
[section 17](https://www.law.go.kr/LSW/lsSideInfoP.do?docCls=jo&joBrNo=00&joNo=0017&lsiSeq=283839&urlMode=lsScJoRltInfoR)
and [section 28-8](https://www.law.go.kr/LSW/lsSideInfoP.do?docCls=jo&joBrNo=08&joNo=0028&lsiSeq=283839&urlMode=lsScJoRltInfoR)
(effective 2026-09-11).

Declining optional personal-data consent must not prevent unrelated SDK use.
A workspace administrator's technical authorization does not automatically
supply the consent of other data subjects. Connecting a backend does not remove
the controller's own obligations.

## SDK 0.2.0 notice and receipt API

Import the asynchronous helpers from `@altifigence/dds-plugin-sdk/consent`.
They require WebCrypto SHA-256. These are SDK data contracts, not a legally
mandated receipt schema. The parsers reject unknown fields: keep host audit
metadata, credentials and storage details in a separate record.

| Function | Operation |
| --- | --- |
| `createNotice({id, version, locale, text, purpose})` | Validate resolved text and calculate its hashes |
| `parseNotice(value)` | Recalculate both notice hashes and reject mismatches |
| `createConsentReceipt(input)` | Assign the receipt schema and validate an explicit caller-supplied choice |
| `parseConsentReceipt(value)` | Validate a receipt or JSON string without authenticating its author |
| `createPermissionGrant(input)` | Create a manifest-v2 permission record tied to the exact package and host scope |
| `isPermissionGranted(receipt, expectedIdentity, permission, now, invalidations)` | Check a grant against current identity, time, expiry and supplied invalidation events |
| `revokeConsentReceipt(receipt, {receiptId, actorRef, occurredAt})` | Create a separate revocation or withdrawal event without changing the original |

### Notices and their hashes

A notice has schema `dds-plugin-notice.v1`, an ID, SemVer `version`, language
`locale`, resolved plain `text` and `purpose`. `contentSha256` hashes the exact
UTF-8 text. `sha256` hashes the UTF-8 JSON serialization of
`{id, version, locale, text, purpose}` in that field order. The receipt preserves
the whole notice and both hashes, rather than linking to a mutable web page.
Use the language and fully resolved text actually presented to the person.
The documentation's brace placeholders must be replaced before `createNotice`;
unresolved placeholders and invalid Unicode are rejected.

### Separate decisions

| Kind | Accepted decisions | Required decision-specific data |
| --- | --- | --- |
| `pluginPermissionGrant` | `granted`, `denied`, `revoked` | Manifest-v2 package identity, host, `permissions` and `expiresAt`; denied/revoked permissions are `[]` |
| `noticeAcknowledgement` | `acknowledged`, `declined` | The exact information notice; no permissions or personal-data processing fields |
| `pluginLicenseAcceptance` | `accepted`, `declined` | Package identity and the actual applicable plugin terms notice; separate from Apache SDK licensing |
| `optionalPersonalDataConsent` | `accepted`, `declined`, `withdrawn` | The separate optional-consent notice and required `processing` disclosures |
| `publisherAgreementAcceptance` | None in this release | Always rejected with `ErrorCode.CAPABILITY_UNAVAILABLE` (`capability_unavailable`); no central publisher agreement service is enabled |

Every receipt has `schemaVersion: "dds-plugin-consent.v1"`, `receiptId`, `kind`,
`decision`, `actorRef`, `occurredAt`, `notice` and `scope: {workspaceId,
generation}`. The scope's generation is an opaque string identifying the host's
current workspace generation; the Node workspace server uses a UUID per start.
Use UTC ISO timestamps ending in `Z`, with seconds or three-digit
milliseconds. An actor reference and a timestamp are caller-supplied data;
the SDK does not prove who acted or when. Independent local SDK use does not
require an Altifigence account.

For a permission grant, `createPermissionGrant` takes `manifest`,
`artifactSha256`, `workspaceId`, `generation`, `permissions`, `notice`,
`decision`, `receiptId`, `actorRef`, `occurredAt`, `expiresAt` and `host`, with
optional `supersedesReceiptId`. It requires manifest v2, a supported host and a
permission subset of that manifest's requests. It preserves
`plugin: {id, version, publisher, artifactSha256, manifestSha256, manifestJson}`
and `host: {id, version, protocolVersion: 1}`. Pass the manifest's original JSON
string to bind its exact text; object input is parsed and serialized before
hashing, so its digest can differ from the package's original manifest bytes.

For `optionalPersonalDataConsent`, `processing` must contain `legalBasis:
"consent"`, `optional: true`, `dataCategories`, `purpose`, `recipient`,
`contact`, `endpointOrigin`, `destinationCountries`, `transferTiming`,
`transferMethod`, `retention`, `refusalEffect` and `withdrawalMethod`. The two
arrays must contain nonempty unique disclosures. The endpoint must be a
canonical HTTPS or strict loopback HTTP origin, without a path, query, fragment
or credentials. For another legal basis, present information and use an
acknowledgement if needed; do not label it consent or claim this helper decides
the lawful basis.

### Create and evaluate a scoped permission record

The following host-side function records a choice only after the host has
presented the notice and obtained that choice. It accepts a verified release
identity and the host's trusted current identity/time; the SDK does not perform
those verification or presentation steps:

```js
import {
  createNotice, createPermissionGrant, isPermissionGranted,
} from '@altifigence/dds-plugin-sdk/consent';

async function recordDocumentChoice({
  manifestJson, artifactSha256, workspaceId, generation,
  receiptId, actorRef, decision, occurredAt, expiresAt, now, host,
}) {
  const notice = await createNotice({
    id: 'document-permission', version: '1.0.0', locale: 'en',
    text: 'Allow this plugin to read the active document in the selected workspace.',
    purpose: 'Grant active-document access for diagnostics',
  });
  const receipt = await createPermissionGrant({
    manifest: manifestJson, artifactSha256, workspaceId, generation,
    permissions: decision === 'granted' ? ['document.read'] : [],
    notice, decision, receiptId, actorRef, occurredAt, expiresAt, host,
  });
  const allowed = await isPermissionGranted(receipt, {
    pluginId: receipt.plugin.id, pluginVersion: receipt.plugin.version,
    publisher: receipt.plugin.publisher, artifactSha256,
    manifestSha256: receipt.plugin.manifestSha256, workspaceId, generation,
    hostId: host.id, hostVersion: host.version, noticeSha256: notice.sha256,
  }, 'document.read', now, []);
  return { receipt, allowed };
}
```

For ongoing operations, obtain expected identity independently from the current
verified package and trusted host state; do not trust identity fields merely
because they appear in a receipt. A diagnostics provider also needs
`diagnostics.publish`; granting `document.read` alone does not grant it.

### Host enforcement and storage

The SDK validates structure, declared permission subsets, identities and notice
digests. `isPermissionGranted` checks exact plugin/version/publisher, artifact
and manifest hashes, workspace generation, host ID/version, notice hash,
requested permission and the active time interval. The host must supply current
identities and time plus every relevant invalidation event; an omitted event
cannot be discovered by the SDK. It must enforce access at each operation and
provide its own code isolation, actor authentication and receipt persistence.

Keep the original receipt and store revocation/withdrawal as a separate event
with `invalidatesReceiptId`. An optional `supersedesReceiptId` relates a new
decision to an earlier one; it does not by itself make an old grant unusable.
Change the trusted workspace generation or provide an explicit invalidation
when older access should stop. Review changed package, permissions, backend,
recipient, country, purpose and retention before using an earlier choice.
Changes to consent disclosures may require renewed consent under the cited law.

On disable or revocation, stop future authorized calls and cancel pending work
as the host can enforce. Do not claim that previously transferred data has been
deleted without verified receiving-service behavior. Store no credential values
or project content in these records, and apply a stated retention policy rather
than indefinite retention. A local receipt is unsigned data, not authenticated
server evidence, tamper-proof storage or a legal signature. It creates no code
isolation and no account-level Marketplace acceptance.
