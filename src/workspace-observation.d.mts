import type {JobSnapshot, JobEvent} from './jobs.mjs';
export const WORKSPACE_OBSERVATION_LIMITS: Readonly<{observers:number;files:number;minIntervalMs:number;maxIntervalMs:number;defaultIntervalMs:number;maxTimeoutMs:number}>;
export interface WorkspaceObservationOptions {
  readonly signal?: AbortSignal;
  readonly intervalMs?: number;
  /** Deadline of each individual HTTP request. */
  readonly requestTimeoutMs?: number;
  /** Total observation duration, starting with the first next(). */
  readonly timeoutMs?: number;
}
export interface WorkspaceFileWatchOptions extends WorkspaceObservationOptions {readonly includeInitial?: boolean;}
export interface WorkspaceJobWatchOptions extends WorkspaceObservationOptions {readonly after?: number;}
export interface WorkspaceFileChange {
  readonly kind: 'initial' | 'created' | 'changed' | 'deleted';
  readonly path: string;
  readonly previousRevision: string | null;
  readonly revision: string | null;
}
export interface WorkspaceJobUpdate {
  readonly snapshot: JobSnapshot;
  readonly events: readonly JobEvent[];
  readonly after: number;
  readonly nextCursor: number;
  readonly dropped: number;
  readonly hasMore: boolean;
}
export interface WorkspaceObserver<T> extends AsyncIterableIterator<T> {
  return(): Promise<IteratorResult<T, undefined>>;
}
