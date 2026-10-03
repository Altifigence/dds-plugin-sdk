import type {HostId, Permission, PluginManifestV2} from './index.mjs';

export const NOTICE_SCHEMA_VERSION: 'dds-plugin-notice.v1';
export const CONSENT_SCHEMA_VERSION: 'dds-plugin-consent.v1';
export interface NoticeInput {
  readonly id: string;
  readonly version: string;
  readonly locale: string;
  readonly text: string;
  readonly purpose: string;
}
export interface Notice extends NoticeInput {
  readonly schemaVersion: typeof NOTICE_SCHEMA_VERSION;
  /** SHA-256 of exact resolved text, encoded as UTF-8. */
  readonly contentSha256: string;
  /** SHA-256 of the fixed-order JSON identity/language/text/purpose envelope. */
  readonly sha256: string;
}
export interface ConsentScope {
  readonly workspaceId: string;
  /** Opaque host generation identity; workspace servers use a fresh UUID per start.
   * Backend configuration must be immutable for this generation; changes require rotation and fresh approval. */
  readonly generation: string;
}
export interface ConsentHost {
  readonly id: HostId;
  readonly version: string;
  readonly protocolVersion: 1;
}
export interface ConsentPluginIdentity {
  readonly id: string;
  readonly version: string;
  /** A declared label, not an authenticated publisher identity. */
  readonly publisher: string;
  readonly artifactSha256: string;
  readonly manifestSha256: string;
  /** Exact preserved UTF-8 manifest payload hashed by manifestSha256. */
  readonly manifestJson: string;
}
export interface ConsentRecordBase {
  readonly receiptId: string;
  readonly actorRef: string;
  /** Host-supplied UTC ISO timestamp. The SDK does not authenticate its source. */
  readonly occurredAt: string;
  readonly notice: Notice;
  readonly scope: ConsentScope;
  readonly expiresAt?: string;
  readonly supersedesReceiptId?: string;
  readonly plugin?: ConsentPluginIdentity;
  readonly host?: ConsentHost;
}
export interface PermissionGrantInput extends ConsentRecordBase {
  readonly kind: 'pluginPermissionGrant';
  readonly decision: 'granted' | 'denied' | 'revoked';
  readonly plugin: ConsentPluginIdentity;
  readonly host: ConsentHost;
  readonly permissions: readonly Permission[];
  readonly expiresAt: string;
  /** Required for revoked; forbidden for granted or denied. */
  readonly invalidatesReceiptId?: string;
}
export interface NoticeAcknowledgementInput extends ConsentRecordBase {
  readonly kind: 'noticeAcknowledgement';
  readonly decision: 'acknowledged' | 'declined';
}
export interface PluginLicenseAcceptanceInput extends ConsentRecordBase {
  readonly kind: 'pluginLicenseAcceptance';
  readonly decision: 'accepted' | 'declined';
  readonly plugin: ConsentPluginIdentity;
}
export interface PersonalDataProcessing {
  readonly legalBasis: 'consent';
  readonly optional: true;
  readonly dataCategories: readonly string[];
  readonly purpose: string;
  readonly recipient: string;
  readonly contact: string;
  /** HTTPS origin or strict loopback HTTP origin; credentials, paths and queries are rejected. */
  readonly endpointOrigin: string;
  readonly destinationCountries: readonly string[];
  readonly transferTiming: string;
  readonly transferMethod: string;
  readonly retention: string;
  readonly refusalEffect: string;
  readonly withdrawalMethod: string;
}
export interface OptionalPersonalDataConsentInput extends ConsentRecordBase {
  readonly kind: 'optionalPersonalDataConsent';
  readonly decision: 'accepted' | 'declined' | 'withdrawn';
  readonly processing: PersonalDataProcessing;
  /** Required for withdrawn; forbidden for accepted or declined. */
  readonly invalidatesReceiptId?: string;
}
/** Reserved service kind. Every creation/parse attempt rejects with capability_unavailable. */
export interface PublisherAgreementAcceptanceInput extends ConsentRecordBase {
  readonly kind: 'publisherAgreementAcceptance';
  readonly decision: 'accepted' | 'declined';
}
export type ConsentReceiptInput = PermissionGrantInput | NoticeAcknowledgementInput | PluginLicenseAcceptanceInput | OptionalPersonalDataConsentInput;
export type ConsentReceipt = ConsentReceiptInput & {readonly schemaVersion: typeof CONSENT_SCHEMA_VERSION};
export type PermissionGrantReceipt = PermissionGrantInput & {readonly schemaVersion: typeof CONSENT_SCHEMA_VERSION};
export interface CreatePermissionGrantInput {
  /** v2 object or preserved JSON text. v1 manifests are rejected. */
  readonly manifest: PluginManifestV2 | string;
  readonly artifactSha256: string;
  readonly workspaceId: string;
  readonly generation: string;
  readonly permissions: readonly Permission[];
  readonly notice: Notice;
  readonly decision: 'granted' | 'denied';
  readonly receiptId: string;
  readonly actorRef: string;
  readonly occurredAt: string;
  readonly expiresAt: string;
  readonly host: ConsentHost;
  readonly supersedesReceiptId?: string;
}
export interface ExpectedPermissionIdentity {
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly publisher: string;
  readonly artifactSha256: string;
  readonly manifestSha256: string;
  readonly workspaceId: string;
  readonly generation: string;
  readonly hostId: HostId;
  readonly hostVersion: string;
  readonly noticeSha256: string;
}
export interface RevocationAction {
  readonly receiptId: string;
  readonly actorRef: string;
  readonly occurredAt: string;
}

/** Requires WebCrypto. Does not present a notice or record a user decision. */
export function createNotice(input: NoticeInput): Promise<Notice>;
export function parseNotice(value: unknown): Promise<Notice>;
/** Records an explicit caller action; performs no upload, persistence or activation. */
export function createConsentReceipt(input: ConsentReceiptInput): Promise<ConsentReceipt>;
export function createConsentReceipt(input: PublisherAgreementAcceptanceInput): Promise<never>;
export function parseConsentReceipt(value: unknown): Promise<ConsentReceipt>;
export function createPermissionGrant(input: CreatePermissionGrantInput): Promise<PermissionGrantReceipt>;
/** Creates a separate revocation/withdrawal event without overwriting the original receipt. */
export function revokeConsentReceipt(receipt: unknown, action: RevocationAction): Promise<ConsentReceipt>;
/** Data evaluation only. The trusted host must supply current identity/time and complete invalidations, and enforce access.
 * A backend configuration change must rotate generation and obtain fresh approval before reusing backend.invoke. */
export function isPermissionGranted(receipt: unknown, expectedIdentity: ExpectedPermissionIdentity, permission: Permission, now: string, invalidations?: readonly ConsentReceipt[]): Promise<boolean>;
