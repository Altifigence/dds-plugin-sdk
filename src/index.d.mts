export const PROTOCOL_VERSION: 1;
export const LIMITS: Readonly<{
  manifestBytes: number; requestBytes: number; resultBytes: number; documentBytes: number;
  maxDiagnostics: number; messageLength: number; maxRegistrations: number; maxPendingRequests: number;
  defaultTimeoutMs: number; maxTimeoutMs: number;
}>;
export const ErrorCode: Readonly<{
  INVALID_CONTRACT: 'invalid_contract'; PERMISSION_DENIED: 'permission_denied';
  UNSUPPORTED_HOST: 'unsupported_host'; VERSION_MISMATCH: 'version_mismatch';
  CANCELLED: 'cancelled'; STALE_SNAPSHOT: 'stale_snapshot'; BUDGET_EXCEEDED: 'budget_exceeded';
  DISPOSED: 'disposed'; PROVIDER_FAILED: 'provider_failed'; PROVIDER_UNAVAILABLE: 'provider_unavailable';
}>;
export type PluginErrorCode = typeof ErrorCode[keyof typeof ErrorCode];
export class PluginSdkError extends Error {
  readonly code: PluginErrorCode;
  constructor(code: PluginErrorCode, message: string);
}
export type Permission = 'document.read' | 'diagnostics.publish';
export interface PluginManifest {
  readonly manifestVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly publisher: string;
  readonly version: string;
  readonly protocolVersion: 1;
  readonly entry: string;
  readonly capabilities: readonly 'diagnostics'[];
  readonly permissions: readonly Permission[];
  readonly supportedHosts: readonly 'test-host'[];
  readonly license: string;
}
export interface Scope { readonly projectId: string; readonly sessionId: string; }
export interface SnapshotIdentity {
  readonly uri: string;
  readonly languageId: string;
  readonly modelVersion: number;
  readonly workspaceRevision: string;
}
export interface DocumentSnapshot extends SnapshotIdentity { readonly text: string; }
/** Zero-based lines and UTF-16 code-unit offsets within each line. */
export interface Position { readonly line: number; readonly character: number; }
export interface Range { readonly start: Position; readonly end: Position; }
export interface Diagnostic {
  readonly range: Range;
  readonly severity: 'error' | 'warning' | 'info' | 'hint';
  readonly message: string;
  readonly code?: string;
  readonly source?: string;
}
export interface DiagnosticsRequest {
  readonly protocolVersion: 1;
  readonly requestId: string;
  readonly scope: Scope;
  readonly snapshot: DocumentSnapshot;
}
export interface DiagnosticsResult {
  readonly protocolVersion: 1;
  readonly requestId: string;
  readonly scope: Scope;
  readonly snapshot: SnapshotIdentity;
  readonly diagnostics: readonly Diagnostic[];
}
export interface Disposable { dispose(): void; }
export interface ProviderSelector { readonly languages: readonly string[]; readonly priority?: number; }
export interface DiagnosticsProvider {
  provideDiagnostics(request: DiagnosticsRequest, options: {readonly signal: AbortSignal}): DiagnosticsResult | Promise<DiagnosticsResult>;
}
export interface PluginContext {
  readonly host: {readonly id: 'test-host'; readonly version: string; readonly protocolVersion: 1};
  readonly pluginId: string;
  readonly scope: Scope;
  readonly grants: readonly Permission[];
  readonly signal: AbortSignal;
  registerDiagnosticsProvider(selector: ProviderSelector, provider: DiagnosticsProvider): Disposable;
}
export interface Plugin {
  readonly manifest: PluginManifest;
  activate(context: PluginContext): void | Disposable | Promise<void | Disposable>;
}
export interface RequestOptions { readonly signal?: AbortSignal; readonly timeoutMs?: number; }
export interface DiagnosticsRegistry extends Disposable {
  register(pluginId: string, selector: ProviderSelector, provider: DiagnosticsProvider): Disposable;
  request(request: DiagnosticsRequest, options?: RequestOptions): Promise<DiagnosticsResult>;
  invalidate(): void;
}
export function parseManifest(value: unknown): PluginManifest;
export function parseDocumentSnapshot(value: unknown): DocumentSnapshot;
export function parseDiagnosticsRequest(value: unknown): DiagnosticsRequest;
export function parseDiagnosticsResult(value: unknown): DiagnosticsResult;
export function createDiagnosticsResult(request: DiagnosticsRequest, diagnostics: readonly Diagnostic[]): DiagnosticsResult;
export function definePlugin(manifest: PluginManifest, activate: Plugin['activate']): Plugin;
/** For trusted host implementers. Authorization and isolation belong to the host. */
export function createDiagnosticsRegistry(options?: {readonly isCurrent?: (request: DiagnosticsRequest) => boolean}): DiagnosticsRegistry;
