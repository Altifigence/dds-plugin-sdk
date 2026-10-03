import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createNotice, parseNotice, createConsentReceipt, parseConsentReceipt, createPermissionGrant, revokeConsentReceipt, isPermissionGranted} from '../src/consent.mjs';

const manifest = {
  manifestVersion: 2, id: 'consent-plugin', name: 'Consent plugin', publisher: 'example', version: '1.0.0',
  protocolVersion: 1, entry: './plugin.mjs', runtime: 'workspace', capabilities: ['commands'],
  permissions: ['workspace.read', 'backend.invoke'], supportedHosts: ['workspace-host'], license: 'Apache-2.0',
  source: {visibility: 'open', licenseFile: 'LICENSE'},
};
const noticeInput = {id: 'read-workspace', version: '1.0.0', locale: 'en', text: 'Read the selected workspace for local lint. Refuse or revoke to block future reads.', purpose: 'Selected workspace read'};
const occurredAt = '2026-10-03T00:00:00.000Z';
const expiresAt = '2026-10-03T01:00:00.000Z';
const now = '2026-10-03T00:30:00.000Z';
const scope = {workspaceId: '22ab8f7a-ff1a-4ab7-9d13-f1399c42b101', generation: 'a8d785ba-5405-4b73-b32a-59968ecef013'};
const host = {id: 'workspace-host', version: '0.2.0', protocolVersion: 1};
const invalid = error => error?.code === 'invalid_contract';
const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');
const clone = value => structuredClone(value);
async function grant(changes = {}) {
  return createPermissionGrant({manifest, artifactSha256: 'a'.repeat(64), ...scope, permissions: ['workspace.read'], notice: await createNotice(noticeInput), decision: 'granted', receiptId: 'grant-1', actorRef: 'local-user', occurredAt, expiresAt, host, ...changes});
}
function identity(receipt) {
  return {pluginId: receipt.plugin.id, pluginVersion: receipt.plugin.version, publisher: receipt.plugin.publisher,
    artifactSha256: receipt.plugin.artifactSha256, manifestSha256: receipt.plugin.manifestSha256,
    ...receipt.scope, hostId: receipt.host.id, hostVersion: receipt.host.version, noticeSha256: receipt.notice.sha256};
}
async function acknowledgement() {
  return createConsentReceipt({receiptId: 'ack-1', kind: 'noticeAcknowledgement', decision: 'acknowledged', actorRef: 'local-user', occurredAt, notice: await createNotice(noticeInput), scope});
}
const processing = {
  legalBasis: 'consent', optional: true, dataCategories: ['Contact email'], purpose: 'Send a requested diagnostic report',
  recipient: 'Example operator', contact: 'privacy@example.org', endpointOrigin: 'https://backend.example.org',
  destinationCountries: ['Republic of Korea'], transferTiming: 'Only after the send action', transferMethod: 'HTTPS request',
  retention: 'Seven days', refusalEffect: 'The report is not sent; local editing continues', withdrawalMethod: 'Contact privacy@example.org',
};
async function personal(changes = {}) {
  return createConsentReceipt({receiptId: 'privacy-1', kind: 'optionalPersonalDataConsent', decision: 'declined', actorRef: 'local-subject', occurredAt,
    notice: await createNotice({...noticeInput, id: 'report-privacy', purpose: 'Optional report processing', text: 'The report may include a contact email and is sent to Example operator only after a separate send action. Declining preserves local editing.'}), scope, processing, ...changes});
}

test('exact UTF-8 text digest and language envelope digest remain separate', async () => {
  const notice = await createNotice({...noticeInput, text: '한글 notice\r\nExact bytes 😀'});
  assert.equal(notice.contentSha256, digest(notice.text));
  assert.equal(notice.sha256, digest(JSON.stringify({id: notice.id, version: notice.version, locale: notice.locale, text: notice.text, purpose: notice.purpose})));
  const korean = await createNotice({...noticeInput, locale: 'ko'});
  const english = await createNotice(noticeInput);
  assert.equal(korean.contentSha256, english.contentSha256);
  assert.notEqual(korean.sha256, english.sha256);
  assert.notEqual((await createNotice({...noticeInput, text: noticeInput.text + ' '})).contentSha256, english.contentSha256);
  assert.notEqual((await createNotice({...noticeInput, purpose: 'Different purpose'})).sha256, english.sha256);
  assert.notEqual((await createNotice({...noticeInput, version: '1.0.1'})).sha256, english.sha256);
  assert.ok(Object.isFrozen(notice));
  assert.deepEqual(await parseNotice(JSON.stringify(notice)), notice);
});

test('notice rejects changed digests, placeholders, malformed Unicode and extra fields', async () => {
  const notice = await createNotice(noticeInput);
  for (const change of [{text: 'Changed notice'}, {locale: 'ko'}, {contentSha256: 'A'.repeat(64)}, {sha256: 'a'.repeat(63)}, {password: 'secret'}, {schemaVersion: 'dds-plugin-notice.v2'}]) {
    await assert.rejects(parseNotice({...notice, ...change}), invalid);
  }
  for (const text of ['Hello {recipient}', 'Hello {{name}}', 'Hello ${name}', 'TODO resolve operator', '<operator>', '\ud800', '\udc00', '\u0000']) {
    await assert.rejects(createNotice({...noticeInput, text}), invalid);
  }
  await assert.rejects(createNotice({...noticeInput, version: 'latest'}), invalid);
  await assert.rejects(createNotice({...noticeInput, locale: 'english'}), invalid);
});

test('accessors, symbols, inherited fields and secret fields never become receipts', async () => {
  let accessed = 0;
  const input = {...noticeInput};
  Object.defineProperty(input, 'text', {enumerable: true, get() {accessed++; return 'secret';}});
  await assert.rejects(createNotice(input), invalid);
  assert.equal(accessed, 0);
  for (const input of [Object.create(noticeInput), {...noticeInput, [Symbol('hidden')]: 'x'}, {...noticeInput, token: 'x'}]) await assert.rejects(createNotice(input), invalid);
  const receipt = await grant();
  for (const change of [{token: 'x'}, {credentialReference: 'x'}, {scope: {...scope, password: 'x'}}, {plugin: {...receipt.plugin, accessToken: 'x'}}, {host: {...host, secret: 'x'}}]) await assert.rejects(parseConsentReceipt({...receipt, ...change}), invalid);
});

test('permission subset binds exact artifact, manifest bytes, workspace, UUID generation, host and notice', async () => {
  const receipt = await grant();
  const expected = identity(receipt);
  assert.equal(await isPermissionGranted(receipt, expected, 'workspace.read', now), true);
  assert.equal(await isPermissionGranted(receipt, expected, 'backend.invoke', now), false);
  for (const change of [{artifactSha256: 'b'.repeat(64)}, {manifestSha256: 'b'.repeat(64)}, {workspaceId: 'another-workspace'}, {generation: 'f9522702-3c9f-49af-bf14-79cfe17ef015'}, {pluginVersion: '1.0.1'}, {pluginId: 'another-plugin'}, {publisher: 'another-publisher'}, {hostVersion: '0.2.1'}, {noticeSha256: 'b'.repeat(64)}]) {
    assert.equal(await isPermissionGranted(receipt, {...expected, ...change}, 'workspace.read', now), false);
  }
  assert.deepEqual(await parseConsentReceipt(JSON.stringify(receipt)), receipt);
  assert.ok(Object.isFrozen(receipt.scope) && Object.isFrozen(receipt.plugin) && Object.isFrozen(receipt.permissions));
  await assert.rejects(grant({generation: 1}), invalid);
  await assert.rejects(grant({generation: ''}), invalid);
});

test('manifest JSON is preserved exactly and cannot be replaced or escalate permissions', async () => {
  const rawManifest = JSON.stringify(manifest, null, 2) + '\n';
  const receipt = await grant({manifest: rawManifest});
  assert.equal(receipt.plugin.manifestJson, rawManifest);
  assert.equal(receipt.plugin.manifestSha256, digest(rawManifest));
  for (const change of [{manifestJson: JSON.stringify(manifest)}, {manifestSha256: 'b'.repeat(64)}, {publisher: 'someone-else'}]) await assert.rejects(parseConsentReceipt({...receipt, plugin: {...receipt.plugin, ...change}}), invalid);
  await assert.rejects(grant({permissions: ['workspace.write']}), invalid);
  await assert.rejects(grant({permissions: ['shell.execute']}), invalid);
  await assert.rejects(grant({permissions: ['workspace.read', 'workspace.read']}), invalid);
  await assert.rejects(grant({host: {...host, id: 'test-host'}}), invalid);
  const v1 = {manifestVersion: 1, id: 'v1-plugin', name: 'v1', publisher: 'example', version: '1.0.0', protocolVersion: 1, entry: './plugin.mjs', capabilities: ['diagnostics'], permissions: ['document.read'], supportedHosts: ['test-host'], license: 'Apache-2.0'};
  await assert.rejects(grant({manifest: v1}), invalid);
});

test('denial, expiry and future decisions never enable access', async () => {
  const denied = await grant({decision: 'denied', permissions: []});
  assert.equal(await isPermissionGranted(denied, identity(denied), 'workspace.read', now), false);
  await assert.rejects(grant({decision: 'denied'}), invalid);
  await assert.rejects(grant({decision: 'revoked'}), invalid);
  const receipt = await grant();
  assert.equal(await isPermissionGranted(receipt, identity(receipt), 'workspace.read', '2026-10-02T23:59:59.000Z'), false);
  assert.equal(await isPermissionGranted(receipt, identity(receipt), 'workspace.read', expiresAt), false);
  assert.equal(await isPermissionGranted(receipt, identity(receipt), 'workspace.read', '2026-10-03T02:00:00.000Z'), false);
  await assert.rejects(grant({expiresAt: occurredAt}), invalid);
  const {expiresAt: _expiry, ...missing} = receipt;
  await assert.rejects(parseConsentReceipt(missing), invalid);
});

test('a separate immutable revocation invalidates its exact original receipt', async () => {
  const receipt = await grant();
  const event = await revokeConsentReceipt(receipt, {receiptId: 'revoke-1', actorRef: 'local-user', occurredAt: now});
  assert.equal(receipt.decision, 'granted');
  assert.equal(event.decision, 'revoked');
  assert.equal(event.invalidatesReceiptId, receipt.receiptId);
  assert.deepEqual(event.permissions, []);
  assert.equal(await isPermissionGranted(receipt, identity(receipt), 'workspace.read', now, [event]), false);
  assert.equal(await isPermissionGranted(receipt, identity(receipt), 'workspace.read', '2026-10-03T00:15:00.000Z', [event]), true);
  assert.equal(await isPermissionGranted(event, identity(receipt), 'workspace.read', now), false);
  await assert.rejects(isPermissionGranted(receipt, identity(receipt), 'workspace.read', now, [{...event, scope: {...scope, generation: 'other-generation'}}]), invalid);
  await assert.rejects(isPermissionGranted(receipt, identity(receipt), 'workspace.read', now, [receipt]), invalid);
  await assert.rejects(revokeConsentReceipt(receipt, {receiptId: 'revoke-2', actorRef: 'local-user', occurredAt: '2026-10-02T23:00:00.000Z'}), invalid);
  await assert.rejects(revokeConsentReceipt(receipt, {receiptId: receipt.receiptId, actorRef: 'local-user', occurredAt: now}), invalid);
  const reordered = {...event, scope: {generation: scope.generation, workspaceId: scope.workspaceId}, host: {protocolVersion: 1, version: host.version, id: host.id}};
  assert.equal(await isPermissionGranted(receipt, identity(receipt), 'workspace.read', now, [reordered]), false);
});

test('notice acknowledgement and plugin-license acceptance remain independent of permission', async () => {
  const receipt = await grant();
  const ack = await acknowledgement();
  assert.equal(await isPermissionGranted(ack, identity(receipt), 'workspace.read', now), false);
  await assert.rejects(parseConsentReceipt({...ack, permissions: []}), invalid);
  const license = await createConsentReceipt({receiptId: 'terms-1', kind: 'pluginLicenseAcceptance', decision: 'accepted', actorRef: 'local-user', occurredAt, notice: await createNotice({...noticeInput, id: 'plugin-terms', purpose: 'Optional plugin-specific terms', text: 'These are the selected plugin terms; they do not grant access to workspace data.'}), scope, plugin: receipt.plugin});
  assert.equal(await isPermissionGranted(license, identity(receipt), 'workspace.read', now), false);
  assert.equal(license.plugin.id, manifest.id);
  const {plugin: _plugin, ...missing} = license;
  await assert.rejects(parseConsentReceipt(missing), invalid);
  await assert.rejects(revokeConsentReceipt(ack, {receiptId: 'bad-revocation', actorRef: 'local-user', occurredAt: now}), invalid);
});

test('optional data consent requires resolved disclosures and withdrawal remains separate', async () => {
  const accepted = await personal({decision: 'accepted'});
  assert.equal(accepted.processing.optional, true);
  const withdrawn = await revokeConsentReceipt(accepted, {receiptId: 'withdraw-1', actorRef: 'local-subject', occurredAt: now});
  assert.equal(withdrawn.decision, 'withdrawn');
  assert.equal(withdrawn.invalidatesReceiptId, accepted.receiptId);
  assert.equal(accepted.decision, 'accepted');
  const receipt = await grant();
  assert.equal(await isPermissionGranted(accepted, identity(receipt), 'workspace.read', now), false);
  for (const change of [{optional: false}, {legalBasis: 'contract'}, {retention: '{period}'}, {recipient: 'TODO'}, {dataCategories: []}, {destinationCountries: []}, {token: 'secret'}]) await assert.rejects(personal({processing: {...processing, ...change}}), invalid);
  const {withdrawalMethod: _route, ...missing} = processing;
  await assert.rejects(personal({processing: missing}), invalid);
  await assert.rejects(parseConsentReceipt({...accepted, invalidatesReceiptId: 'earlier'}), invalid);
});

test('data-processing endpoints are origin-only HTTPS or strict local loopback HTTP', async () => {
  for (const endpointOrigin of ['https://backend.example.org', 'http://127.0.0.1:8080', 'http://localhost:8080', 'http://[::1]:8080']) {
    const receipt = await personal({processing: {...processing, endpointOrigin}});
    assert.equal(receipt.processing.endpointOrigin, endpointOrigin);
  }
  for (const endpointOrigin of ['http://backend.example.org', 'http://localhost.evil.org', 'http://0.0.0.0:8080', 'http://127.0.0.1:8080/path', 'https://user:password@backend.example.org', 'https://backend.example.org?token=secret', 'https://backend.example.org/#secret', 'http://2130706433:8080', 'http://127.1:8080']) await assert.rejects(personal({processing: {...processing, endpointOrigin}}), invalid);
});

test('timestamps, decisions and schema kinds fail closed; publisher service is unavailable', async () => {
  for (const bad of ['2026-02-30T00:00:00.000Z', '2026-10-03T00:00:00+09:00', 'tomorrow', 1, '2026-10-03']) await assert.rejects(grant({occurredAt: bad}), invalid);
  const receipt = await grant();
  assert.ok(await createPermissionGrant({...manifestGrantInput(receipt), occurredAt: '2026-10-03T00:00:00Z', expiresAt: '2026-10-03T01:00:00Z'}));
  for (const change of [{kind: 'sdkLicenseAcceptance'}, {kind: 'unknown'}, {decision: 'viewed'}, {schemaVersion: 'dds-plugin-consent.v2'}, {actorRef: '{actor}'}, {receiptId: ''}]) await assert.rejects(parseConsentReceipt({...receipt, ...change}), invalid);
  await assert.rejects(createConsentReceipt({...await acknowledgement(), kind: 'publisherAgreementAcceptance'}), invalid); // schemaVersion is assigned, not caller supplied.
  const {schemaVersion: _schema, ...input} = await acknowledgement();
  await assert.rejects(createConsentReceipt({...input, kind: 'publisherAgreementAcceptance', decision: 'accepted'}), error => error?.code === 'capability_unavailable');
  await assert.rejects(parseConsentReceipt({...receipt, kind: 'publisherAgreementAcceptance'}), error => error?.code === 'capability_unavailable');
});
function manifestGrantInput(receipt) {
  return {manifest, artifactSha256: receipt.plugin.artifactSha256, ...scope, permissions: ['workspace.read'], notice: receipt.notice, decision: 'granted', receiptId: 'second-grant', actorRef: receipt.actorRef, occurredAt, expiresAt, host};
}

test('missing choice never defaults to granted and a CLI Enter records denial without upload', async () => {
  const receipt = await grant();
  const {decision: _decision, ...input} = manifestGrantInput(receipt);
  await assert.rejects(createPermissionGrant(input), invalid);
  const result = spawnSync(process.execPath, ['examples/consent/prompt.mjs'], {cwd: fileURLToPath(new URL('..', import.meta.url)), input: '\n', encoding: 'utf8', timeout: 10_000});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"decision": "denied"/);
  assert.match(result.stdout, /"permissions": \[\]/);
  assert.match(result.stdout, /Permission evaluation: false/);
  assert.match(result.stdout, /never executes a plugin or sends data/);
});

test('bounded JSON prevents oversized notices and excessively nested input', async () => {
  await assert.rejects(createNotice({...noticeInput, text: 'x'.repeat(32_769)}), invalid);
  await assert.rejects(parseConsentReceipt(' '.repeat(131_073)), error => error?.code === 'budget_exceeded');
  const notice = await createNotice(noticeInput);
  const malformed = {receiptId: 'bad', kind: 'noticeAcknowledgement', decision: 'acknowledged', actorRef: 'local-user', occurredAt, notice, scope};
  let nested = malformed;
  for (let index = 0; index < 20; index++) nested = {nested};
  await assert.rejects(createConsentReceipt(nested), error => error?.code === 'budget_exceeded');
});
