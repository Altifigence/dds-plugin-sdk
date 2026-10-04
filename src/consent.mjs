import { parseJsonValue, parseManifest } from './contracts.mjs';
import { ErrorCode, PluginSdkError } from './limits.mjs';
import { SEMVER_PATTERN } from './patterns.mjs';

export const NOTICE_SCHEMA_VERSION = 'dds-plugin-notice.v1';
export const CONSENT_SCHEMA_VERSION = 'dds-plugin-consent.v1';
const encoder = new TextEncoder();
const hashPattern = /^[a-f0-9]{64}$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const semver = new RegExp(SEMVER_PATTERN);
const placeholderPattern = /\{[^{}\r\n]+\}|\$\{|\{\{|<[^>\r\n]+>|\b(?:TODO|TBD|PLACEHOLDER|REPLACE_ME)\b/i;
const permissionNames = ['document.read', 'diagnostics.publish', 'workspace.read', 'workspace.write', 'backend.invoke', 'language.provide', 'settings.read', 'secrets.resolve'];
const decisions = {
  pluginPermissionGrant: ['granted', 'denied', 'revoked'],
  noticeAcknowledgement: ['acknowledged', 'declined'],
  pluginLicenseAcceptance: ['accepted', 'declined'],
  optionalPersonalDataConsent: ['accepted', 'declined', 'withdrawn'],
};

function fail(path, message) { throw new PluginSdkError(ErrorCode.INVALID_CONTRACT, `${path}: ${message}`); }
function copy(value) {
  if (typeof value === 'string') {
    if (encoder.encode(value).length > 131_072) throw new PluginSdkError(ErrorCode.BUDGET_EXCEEDED, 'Consent JSON byte limit exceeded');
    try { value = JSON.parse(value); } catch { fail('consent', 'expected valid JSON'); }
  }
  const result = parseJsonValue(value);
  if (encoder.encode(JSON.stringify(result)).length > 131_072) throw new PluginSdkError(ErrorCode.BUDGET_EXCEEDED, 'Consent JSON byte limit exceeded');
  return result;
}
function record(value, required, optional, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected a record');
  if (Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail(path, 'unexpected field');
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, 'required');
}
function text(value, path, max = 2048) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || placeholderPattern.test(value)) fail(path, 'expected resolved plain text within its limit');
  // Reject unpaired surrogates: TextEncoder would otherwise silently replace them.
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail(path, 'invalid Unicode');
    } else if (code >= 0xdc00 && code <= 0xdfff) fail(path, 'invalid Unicode');
  }
  return value;
}
function id(value, path) { if (!idPattern.test(text(value, path, 128))) fail(path, 'invalid identity'); return value; }
function hash(value, path) { if (typeof value !== 'string' || !hashPattern.test(value)) fail(path, 'expected lowercase SHA-256'); return value; }
function timestamp(value, path) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) fail(path, 'expected UTC ISO timestamp');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== (value.includes('.') ? value : value.slice(0, -1) + '.000Z')) fail(path, 'invalid calendar timestamp');
  return parsed;
}
function scope(value) {
  record(value, ['workspaceId', 'generation'], [], 'scope');
  id(value.workspaceId, 'scope.workspaceId');
  id(value.generation, 'scope.generation');
  return value;
}
function host(value) {
  record(value, ['id', 'version', 'protocolVersion'], [], 'host');
  if (!['test-host', 'workspace-host'].includes(value.id)) fail('host.id', 'unsupported SDK host');
  if (typeof value.version !== 'string' || !semver.test(value.version)) fail('host.version', 'expected SemVer');
  if (value.protocolVersion !== 1) fail('host.protocolVersion', 'expected 1');
  return value;
}
function permissions(value, path) {
  if (!Array.isArray(value) || value.length > permissionNames.length || new Set(value).size !== value.length || value.some(item => !permissionNames.includes(item))) fail(path, 'expected unique supported permissions');
  return value;
}
function origin(value) {
  text(value, 'processing.endpointOrigin', 2048);
  let url;
  try { url = new URL(value); } catch { fail('processing.endpointOrigin', 'expected an HTTPS or loopback HTTP origin'); }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(url.hostname) && url.hostname.split('.').every(part => Number(part) <= 255);
  if (!(url.protocol === 'https:' || url.protocol === 'http:' && loopback) || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== '/' || value !== url.origin) fail('processing.endpointOrigin', 'expected HTTPS or loopback HTTP origin only, without credentials, path, query or fragment');
}
function processing(value) {
  const fields = ['legalBasis', 'optional', 'dataCategories', 'purpose', 'recipient', 'contact', 'endpointOrigin', 'destinationCountries', 'transferTiming', 'transferMethod', 'retention', 'refusalEffect', 'withdrawalMethod'];
  record(value, fields, [], 'processing');
  if (value.legalBasis !== 'consent' || value.optional !== true) fail('processing', 'requires separate optional consent basis');
  for (const field of ['dataCategories', 'destinationCountries']) {
    if (!Array.isArray(value[field]) || !value[field].length || value[field].length > 32 || new Set(value[field]).size !== value[field].length) fail(`processing.${field}`, 'expected nonempty unique disclosures');
    value[field].forEach(item => text(item, `processing.${field}`, 256));
  }
  for (const field of fields.filter(field => !['legalBasis', 'optional', 'dataCategories', 'destinationCountries', 'endpointOrigin'].includes(field))) text(value[field], `processing.${field}`);
  origin(value.endpointOrigin);
}
async function sha256(value) {
  if (!globalThis.crypto?.subtle) throw new PluginSdkError(ErrorCode.PROVIDER_UNAVAILABLE, 'WebCrypto SHA-256 is unavailable');
  return [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function noticeFields(value, includeHashes) {
  record(value, ['id', 'version', 'locale', 'text', 'purpose', ...(includeHashes ? ['schemaVersion', 'contentSha256', 'sha256'] : [])], [], 'notice');
  id(value.id, 'notice.id');
  if (typeof value.version !== 'string' || !semver.test(value.version)) fail('notice.version', 'expected SemVer');
  if (typeof value.locale !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value.locale)) fail('notice.locale', 'expected language tag');
  text(value.text, 'notice.text', 32_768);
  text(value.purpose, 'notice.purpose');
  if (includeHashes && value.schemaVersion !== NOTICE_SCHEMA_VERSION) fail('notice.schemaVersion', 'unsupported notice version');
}
function noticePayload(value) { return {id: value.id, version: value.version, locale: value.locale, text: value.text, purpose: value.purpose}; }

/** Hash exact resolved UTF-8 text and its versioned language/purpose envelope. No action is inferred. */
export async function createNotice(input) {
  input = copy(input);
  noticeFields(input, false);
  const payload = noticePayload(input);
  return Object.freeze({schemaVersion: NOTICE_SCHEMA_VERSION, ...payload, contentSha256: await sha256(input.text), sha256: await sha256(JSON.stringify(payload))});
}

/** Recompute both digests; supplied notices must preserve the exact presented text. */
export async function parseNotice(value) {
  value = copy(value);
  noticeFields(value, true);
  hash(value.contentSha256, 'notice.contentSha256'); hash(value.sha256, 'notice.sha256');
  if (await sha256(value.text) !== value.contentSha256 || await sha256(JSON.stringify(noticePayload(value))) !== value.sha256) fail('notice', 'notice digest mismatch');
  return value;
}

async function pluginIdentity(value) {
  record(value, ['id', 'version', 'publisher', 'artifactSha256', 'manifestSha256', 'manifestJson'], [], 'plugin');
  hash(value.artifactSha256, 'plugin.artifactSha256'); hash(value.manifestSha256, 'plugin.manifestSha256');
  if (typeof value.manifestJson !== 'string') fail('plugin.manifestJson', 'required preserved JSON text');
  const manifest = parseManifest(value.manifestJson);
  if (manifest.manifestVersion !== 2 || value.id !== manifest.id || value.version !== manifest.version || value.publisher !== manifest.publisher || await sha256(value.manifestJson) !== value.manifestSha256) fail('plugin', 'manifest identity mismatch');
  return manifest;
}

/** Validate a local, unsigned record. This does not authenticate the actor, time, publisher or storage. */
export async function parseConsentReceipt(value) {
  value = copy(value);
  record(value, ['schemaVersion', 'receiptId', 'kind', 'decision', 'actorRef', 'occurredAt', 'notice', 'scope'], ['plugin', 'host', 'permissions', 'expiresAt', 'invalidatesReceiptId', 'supersedesReceiptId', 'processing'], 'receipt');
  if (value.schemaVersion !== CONSENT_SCHEMA_VERSION) fail('receipt.schemaVersion', 'unsupported receipt version');
  if (value.kind === 'publisherAgreementAcceptance') throw new PluginSdkError(ErrorCode.CAPABILITY_UNAVAILABLE, 'Publisher agreement service is not enabled');
  if (!Object.hasOwn(decisions, value.kind) || !decisions[value.kind].includes(value.decision)) fail('receipt', 'unknown kind or decision');
  id(value.receiptId, 'receiptId'); id(value.actorRef, 'actorRef'); scope(value.scope);
  const at = timestamp(value.occurredAt, 'occurredAt');
  await parseNotice(value.notice);
  if (value.expiresAt !== undefined && timestamp(value.expiresAt, 'expiresAt') <= at && !['revoked', 'withdrawn'].includes(value.decision)) fail('expiresAt', 'must follow the decision');
  for (const field of ['invalidatesReceiptId', 'supersedesReceiptId']) if (value[field] !== undefined) {
    id(value[field], field);
    if (value[field] === value.receiptId) fail(field, 'cannot reference itself');
  }
  const invalidation = ['revoked', 'withdrawn'].includes(value.decision);
  if (invalidation !== Object.hasOwn(value, 'invalidatesReceiptId')) fail('invalidatesReceiptId', 'required only for revocation or withdrawal');
  const manifest = value.plugin === undefined ? undefined : await pluginIdentity(value.plugin);
  if (value.host !== undefined) host(value.host);
  if (value.kind === 'pluginPermissionGrant') {
    if (!manifest || !value.host || !value.expiresAt) fail('grant', 'package, host and expiry are required');
    permissions(value.permissions, 'permissions');
    if (!manifest.supportedHosts.includes(value.host.id)) fail('host.id', 'not supported by the manifest');
    if (value.permissions.some(permission => !manifest.permissions.includes(permission))) fail('permissions', 'grant exceeds manifest requests');
    if (value.decision !== 'granted' && value.permissions.length) fail('permissions', 'denied/revoked decisions cannot grant access');
  } else if (Object.hasOwn(value, 'permissions')) fail('permissions', 'only permission grants may carry permissions');
  if (value.kind === 'pluginLicenseAcceptance' && !manifest) fail('plugin', 'package identity is required for plugin terms');
  if (value.kind === 'optionalPersonalDataConsent') processing(value.processing);
  else if (Object.hasOwn(value, 'processing')) fail('processing', 'only optional personal-data consent records processing');
  return value;
}

/** Record an explicit caller-supplied choice. No UI, storage, upload or execution occurs. */
export async function createConsentReceipt(input) {
  input = copy(input);
  if (Object.hasOwn(input, 'schemaVersion')) fail('schemaVersion', 'assigned by receipt creation');
  return parseConsentReceipt({...input, schemaVersion: CONSENT_SCHEMA_VERSION});
}

/** Permission subset tied to exact package, preserved manifest, host, workspace and generation.
 * The host must keep backend configuration immutable within a generation and rotate it on configuration change. */
export async function createPermissionGrant(input) {
  input = copy(input);
  record(input, ['manifest', 'artifactSha256', 'workspaceId', 'generation', 'permissions', 'notice', 'decision', 'receiptId', 'actorRef', 'occurredAt', 'expiresAt', 'host'], ['supersedesReceiptId'], 'grantInput');
  if (!['granted', 'denied'].includes(input.decision)) fail('decision', 'new permission decisions must be granted or denied; use a separate revocation');
  const manifest = parseManifest(input.manifest);
  if (manifest.manifestVersion !== 2) fail('manifest', 'permission receipts require manifest v2');
  const manifestJson = typeof input.manifest === 'string' ? input.manifest : JSON.stringify(manifest);
  return createConsentReceipt({
    receiptId: input.receiptId, kind: 'pluginPermissionGrant', decision: input.decision,
    actorRef: input.actorRef, occurredAt: input.occurredAt, expiresAt: input.expiresAt,
    notice: input.notice, scope: {workspaceId: input.workspaceId, generation: input.generation},
    host: input.host, permissions: input.permissions,
    plugin: {id: manifest.id, version: manifest.version, publisher: manifest.publisher, artifactSha256: input.artifactSha256, manifestSha256: await sha256(manifestJson), manifestJson},
    ...(input.supersedesReceiptId === undefined ? {} : {supersedesReceiptId: input.supersedesReceiptId}),
  });
}

/** Preserve the original and create a separate event. Host must supply every relevant invalidation when evaluating. */
export async function revokeConsentReceipt(receipt, action) {
  const original = await parseConsentReceipt(receipt);
  action = copy(action);
  record(action, ['receiptId', 'actorRef', 'occurredAt'], [], 'revocation');
  if (!['pluginPermissionGrant', 'optionalPersonalDataConsent'].includes(original.kind) || !['granted', 'accepted'].includes(original.decision)) fail('revocation', 'only an active grant or consent can be invalidated');
  if (timestamp(action.occurredAt, 'occurredAt') < timestamp(original.occurredAt, 'original.occurredAt')) fail('occurredAt', 'revocation precedes the original');
  const {schemaVersion: _schema, receiptId: _id, actorRef: _actor, occurredAt: _time, supersedesReceiptId: _supersedes, ...preserved} = original;
  return createConsentReceipt({...preserved, ...action, decision: original.kind === 'pluginPermissionGrant' ? 'revoked' : 'withdrawn', invalidatesReceiptId: original.receiptId, ...(original.kind === 'pluginPermissionGrant' ? {permissions: []} : {})});
}

/** Evaluate data only. The trusted host supplies current identities, time and a complete invalidation set, then enforces access.
 * Generic backend.invoke grants rely on immutable backend configuration per generation; changed configuration requires fresh approval. */
export async function isPermissionGranted(receipt, expectedIdentity, permission, now, invalidations = []) {
  const current = await parseConsentReceipt(receipt);
  const expected = copy(expectedIdentity);
  record(expected, ['pluginId', 'pluginVersion', 'publisher', 'artifactSha256', 'manifestSha256', 'workspaceId', 'generation', 'hostId', 'hostVersion', 'noticeSha256'], [], 'expectedIdentity');
  id(expected.pluginId, 'expectedIdentity.pluginId'); id(expected.publisher, 'expectedIdentity.publisher');
  if (!semver.test(expected.pluginVersion) || !semver.test(expected.hostVersion)) fail('expectedIdentity', 'invalid version');
  scope({workspaceId: expected.workspaceId, generation: expected.generation});
  host({id: expected.hostId, version: expected.hostVersion, protocolVersion: 1});
  for (const field of ['artifactSha256', 'manifestSha256', 'noticeSha256']) hash(expected[field], `expectedIdentity.${field}`);
  permissions([permission], 'permission');
  const time = timestamp(now, 'now');
  const events = copy(invalidations);
  if (!Array.isArray(events) || events.length > 128) fail('invalidations', 'expected bounded invalidation array');
  let invalidated = false;
  for (const event of events) {
    const valid = await parseConsentReceipt(event);
    if (!['revoked', 'withdrawn'].includes(valid.decision)) fail('invalidations', 'expected revocation or withdrawal records');
    if (valid.invalidatesReceiptId === current.receiptId && timestamp(valid.occurredAt, 'revocation.occurredAt') <= time) {
      const samePlugin = current.plugin === undefined ? valid.plugin === undefined : valid.plugin !== undefined && ['id', 'version', 'publisher', 'artifactSha256', 'manifestSha256', 'manifestJson'].every(field => valid.plugin[field] === current.plugin[field]);
      const sameHost = current.host === undefined ? valid.host === undefined : valid.host !== undefined && ['id', 'version', 'protocolVersion'].every(field => valid.host[field] === current.host[field]);
      if (valid.kind !== current.kind || valid.scope.workspaceId !== current.scope.workspaceId || valid.scope.generation !== current.scope.generation || valid.notice.sha256 !== current.notice.sha256 || !samePlugin || !sameHost || timestamp(valid.occurredAt, 'revocation.occurredAt') < timestamp(current.occurredAt, 'occurredAt')) fail('invalidations', 'revocation identity mismatch');
      invalidated = true;
    }
  }
  return current.kind === 'pluginPermissionGrant' && current.decision === 'granted' && !invalidated &&
    time >= timestamp(current.occurredAt, 'occurredAt') && time < timestamp(current.expiresAt, 'expiresAt') &&
    current.plugin.id === expected.pluginId && current.plugin.version === expected.pluginVersion && current.plugin.publisher === expected.publisher &&
    current.plugin.artifactSha256 === expected.artifactSha256 && current.plugin.manifestSha256 === expected.manifestSha256 &&
    current.scope.workspaceId === expected.workspaceId && current.scope.generation === expected.generation &&
    current.host.id === expected.hostId && current.host.version === expected.hostVersion && current.notice.sha256 === expected.noticeSha256 && current.permissions.includes(permission);
}
