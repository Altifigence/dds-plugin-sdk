export const PROTOCOL_VERSION: 1;
export const LIMITS: Readonly<{
  manifestBytes: number; requestBytes: number; resultBytes: number; documentBytes: number;
  maxDiagnostics: number; maxLanguageItems: number; messageLength: number; maxRegistrations: number; maxPendingRequests: number;
  maxCommands: number; commandBytes: number; jsonBytes: number; jsonDepth: number; jsonNodes: number;
  jsonArrayItems: number; jsonObjectProperties: number; maxFiles: number;
  defaultTimeoutMs: number; maxTimeoutMs: number;
}>;
export const ErrorCode: Readonly<{
  INVALID_CONTRACT: 'invalid_contract'; PERMISSION_DENIED: 'permission_denied';
  UNSUPPORTED_HOST: 'unsupported_host'; VERSION_MISMATCH: 'version_mismatch';
  CANCELLED: 'cancelled'; STALE_SNAPSHOT: 'stale_snapshot'; BUDGET_EXCEEDED: 'budget_exceeded';
  DISPOSED: 'disposed'; PROVIDER_FAILED: 'provider_failed'; PROVIDER_UNAVAILABLE: 'provider_unavailable';
  CAPABILITY_UNAVAILABLE: 'capability_unavailable'; CONFLICT: 'conflict';
}>;
export type PluginErrorCode = typeof ErrorCode[keyof typeof ErrorCode];
export class PluginSdkError extends Error {
  readonly code: PluginErrorCode;
  constructor(code: PluginErrorCode, message: string);
}
export type Permission = 'document.read' | 'diagnostics.publish' | 'workspace.read' | 'workspace.write' | 'backend.invoke' | 'language.provide';
export interface PluginManifestV1 {
  readonly manifestVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly publisher: string;
  readonly version: string;
  readonly protocolVersion: 1;
  readonly entry: string;
  readonly capabilities: readonly 'diagnostics'[];
  readonly permissions: readonly ('document.read' | 'diagnostics.publish')[];
  readonly supportedHosts: readonly 'test-host'[];
  readonly license: string;
}
export interface PluginManifestV2 extends Omit<PluginManifestV1, 'manifestVersion' | 'capabilities' | 'permissions' | 'supportedHosts'> {
  readonly manifestVersion: 2;
  readonly runtime: 'ui' | 'workspace';
  readonly capabilities: readonly ('diagnostics' | 'commands' | LanguageFeature)[];
  readonly permissions: readonly Permission[];
  readonly supportedHosts: readonly HostId[];
  readonly source: {
    readonly visibility: 'open' | 'closed';
    readonly repository?: string;
    readonly licenseFile: string;
  };
}
export type PluginManifest = PluginManifestV1 | PluginManifestV2;
export type HostId = 'test-host' | 'workspace-host';
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | {readonly [key: string]: JsonValue};
export interface CommandParameter {
  readonly name: string; readonly label: string; readonly type: 'string' | 'number' | 'boolean';
  readonly required: boolean; readonly choices?: readonly string[];
}
export interface CommandDefinition {
  readonly id: string; readonly title: string; readonly description?: string;
  readonly parameters?: readonly CommandParameter[];
}
export interface RegisteredCommand extends CommandDefinition {readonly pluginId: string;}
export type CommandHandler = (input: JsonValue, options: {readonly signal: AbortSignal}) => JsonValue | Promise<JsonValue>;
export interface WorkspaceFile {readonly path: string; readonly content: string; readonly revision: string;}
export interface WorkspaceWriteResult {readonly path: string; readonly revision: string;}
export interface WorkspaceEntry {readonly path: string; readonly kind: 'file' | 'directory'; readonly revision?: string; readonly name?: string; readonly size?: number;}
export interface WorkspacePort {
  readFile?(path: string, options: {readonly signal: AbortSignal}): WorkspaceFile | Promise<WorkspaceFile>;
  writeFile?(path: string, content: string, options: {readonly expectedRevision: string | null; readonly signal: AbortSignal}): WorkspaceWriteResult | Promise<WorkspaceWriteResult>;
  listFiles?(path: string, options: {readonly signal: AbortSignal}): readonly WorkspaceEntry[] | Promise<readonly WorkspaceEntry[]>;
}
export interface WorkspaceApi {
  readFile(path: string, options?: RequestOptions): Promise<WorkspaceFile>;
  writeFile(path: string, content: string, options: RequestOptions & {readonly expectedRevision: string | null}): Promise<WorkspaceWriteResult>;
  listFiles(path?: string, options?: RequestOptions): Promise<readonly WorkspaceEntry[]>;
}
export type BackendHandler = (input: JsonValue, options: {readonly signal: AbortSignal; readonly pluginId: string; readonly scope: Scope}) => JsonValue | Promise<JsonValue>;
export interface BackendsApi {invoke(id: string, input: JsonValue, options?: RequestOptions): Promise<JsonValue>;}
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
  readonly host: {readonly id: HostId; readonly version: string; readonly protocolVersion: 1};
  readonly pluginId: string;
  readonly scope: Scope;
  readonly grants: readonly Permission[];
  readonly signal: AbortSignal;
  registerDiagnosticsProvider(selector: ProviderSelector, provider: DiagnosticsProvider): Disposable;
  registerLanguageProvider<K extends LanguageFeature>(kind: K, selector: ProviderSelector, provider: LanguageProvider<K>): Disposable;
  registerCommand(command: CommandDefinition, handler: CommandHandler): Disposable;
  readonly workspace: WorkspaceApi;
  readonly backends: BackendsApi;
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
export function parseCommandDefinition(value: unknown): CommandDefinition;
export function parseJsonValue(value: unknown): JsonValue;
export function parseLicenseExpression(value: unknown): string;
export function parseWorkspacePath(value: unknown, options?: {readonly allowRoot?: boolean}): string;
export function parseDocumentSnapshot(value: unknown): DocumentSnapshot;
export function parseDiagnosticsRequest(value: unknown): DiagnosticsRequest;
export function parseDiagnosticsResult(value: unknown): DiagnosticsResult;
export function createDiagnosticsResult(request: DiagnosticsRequest, diagnostics: readonly Diagnostic[]): DiagnosticsResult;
export function definePlugin(manifest: PluginManifest, activate: Plugin['activate']): Plugin;
/** For trusted host implementers. Authorization and isolation belong to the host. */
export function createDiagnosticsRegistry(options?: {readonly isCurrent?: (request: DiagnosticsRequest) => boolean}): DiagnosticsRegistry;
export interface PluginHostOptions {
  readonly hostId?: HostId; readonly scope?: Scope; readonly grants?: readonly Permission[];
  readonly workspace?: WorkspacePort; readonly backends?: Readonly<Record<string, BackendHandler>>;
}
export interface PluginHost extends Disposable {
  activate(plugin: Plugin): Promise<Disposable>;
  setDocument(snapshot: DocumentSnapshot): DocumentSnapshot;
  requestDiagnostics(options?: RequestOptions): Promise<DiagnosticsResult>;
  requestLanguage<K extends LanguageFeature>(kind: K, input: LanguageInput<K>, options?: RequestOptions): Promise<LanguageResult<K>>;
  listCommands(): readonly RegisteredCommand[];
  executeCommand(pluginId: string, commandId: string, input: JsonValue, options?: RequestOptions): Promise<JsonValue>;
  listPlugins(): readonly PluginManifest[];
  deactivate(pluginId: string): void;
}
/** Executes trusted plugins in-process. Ports enforce file/backend authority; this is not a sandbox. */
export function createPluginHost(options?: PluginHostOptions): PluginHost;

export type LanguageFeature = 'completion' | 'hover' | 'definition' | 'references' | 'document-symbols';
export const LANGUAGE_FEATURES: readonly LanguageFeature[];
export type LanguageInput<K extends LanguageFeature> = K extends 'document-symbols'
  ? {readonly position?: never; readonly includeDeclaration?: never}
  : {readonly position: Position} & (K extends 'references' ? {readonly includeDeclaration?: boolean} : {readonly includeDeclaration?: never});
export type LanguageRequest<K extends LanguageFeature = LanguageFeature> = K extends LanguageFeature
  ? DiagnosticsRequest & {readonly kind: K} & LanguageInput<K> : never;
/** Literal insertion and description text, never snippets, HTML or executable commands. */
export interface CompletionItem {readonly label: string; readonly insertText: string; readonly detail?: string; readonly range?: Range;}
export interface Hover {readonly text: string; readonly range?: Range;}
/** Relative workspace path. Hosts must authorize access before opening the target. */
export interface LanguageLocation {readonly path: string; readonly range: Range;}
export interface DocumentSymbol {
  readonly name: string; readonly kind: 'module' | 'namespace' | 'class' | 'interface' | 'function' | 'method' | 'variable' | 'constant' | 'property' | 'type';
  readonly range: Range; readonly selectionRange: Range; readonly detail?: string;
}
export interface LanguageData {
  readonly completion: readonly CompletionItem[];
  readonly hover: Hover | null;
  readonly definition: readonly LanguageLocation[];
  readonly references: readonly LanguageLocation[];
  readonly 'document-symbols': readonly DocumentSymbol[];
}
export type LanguageResult<K extends LanguageFeature = LanguageFeature> = K extends LanguageFeature
  ? Omit<DiagnosticsResult, 'diagnostics'> & {readonly kind: K; readonly data: LanguageData[K]} : never;
export interface LanguageProvider<K extends LanguageFeature> {
  provide(request: LanguageRequest<K>, options: {readonly signal: AbortSignal}): LanguageResult<K> | Promise<LanguageResult<K>>;
}
export interface LanguageRegistry<K extends LanguageFeature> extends Disposable {
  register(pluginId: string, selector: ProviderSelector, provider: LanguageProvider<K>): Disposable;
  request(request: LanguageRequest<K>, options?: RequestOptions): Promise<LanguageResult<K>>;
  invalidate(): void;
}
export function parseLanguageRequest(value: unknown): LanguageRequest;
export function parseLanguageResult(value: unknown): LanguageResult;
export function createLanguageResult<K extends LanguageFeature>(request: LanguageRequest<K>, data: LanguageData[K]): LanguageResult<K>;
/** Trusted host primitive. Authorization and isolation are enforced by the host. */
export function createLanguageRegistry<K extends LanguageFeature>(kind: K, options?: {readonly isCurrent?: (request: LanguageRequest<K>) => boolean}): LanguageRegistry<K>;
