import type {Disposable, RequestOptions} from './index.mjs';
import type {SecretReference} from './data-schema.mjs';
export type {SecretReference} from './data-schema.mjs';
export {parseSecretReference} from './data-schema.mjs';
export const SECRET_LIMITS: Readonly<{references: number; commands: number; pending: number; valueBytes: number; defaultTtlMs: number; maxTtlMs: number}>;
export interface SecretExecutionScope {readonly pluginId: string; readonly workspaceId: string; readonly commandId: string; readonly executionId: string;}
export type SecretLeaseCallback = (bytes: Uint8Array, options: {readonly signal: AbortSignal}) => void | Promise<void>;
export interface SecretResolverPort {withSecret(reference: SecretReference, scope: SecretExecutionScope, callback: SecretLeaseCallback, options?: RequestOptions): void | Promise<void>;}
export interface SecretResolver extends SecretResolverPort, Disposable {
  issue(input: {readonly secretId: string; readonly pluginId: string; readonly workspaceId: string; readonly commandIds: readonly string[]; readonly ttlMs?: number}): SecretReference;
  withSecret(reference: SecretReference, scope: SecretExecutionScope, callback: SecretLeaseCallback, options?: RequestOptions): Promise<void>;
  revoke(reference: SecretReference): boolean;
  inspect(): Readonly<{references: number; pending: number}>;
}
export function createSecretResolver(options: {
  readonly resolve: (request: {readonly secretId: string; readonly reference: SecretReference; readonly scope: SecretExecutionScope; readonly expiresAt: number}, options: {readonly signal: AbortSignal}) => Uint8Array | Promise<Uint8Array>;
  readonly authorize: (request: SecretExecutionScope & {readonly reference: SecretReference; readonly expiresAt: number}) => boolean;
  readonly now?: () => number;
}): SecretResolver;
export interface SecretExecutionApi {withSecret(reference: SecretReference, callback: SecretLeaseCallback, options?: RequestOptions): Promise<void>;}
export interface SecretExecution extends Disposable {readonly scope: SecretExecutionScope; readonly secrets: SecretExecutionApi;}
export function createSecretExecution(resolver: SecretResolverPort, scope: SecretExecutionScope, references: readonly SecretReference[], options?: {readonly signal?: AbortSignal}): SecretExecution;
