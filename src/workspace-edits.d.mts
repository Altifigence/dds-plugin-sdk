import type {WorkspaceClient, WorkspaceRequestOptions} from './workspace-client.mjs';
import type {TextEdit} from './workspace-project.mjs';
import type {WorkspaceErrorCode} from './workspace-protocol.mjs';

export const WORKSPACE_EDIT_LIMITS: Readonly<{changes: 32; edits: 1000; proposalBytes: 1048576; previewBytes: 8388608; journalRecords: 64; journalBytes: 67108864}>;
export const WORKSPACE_EDIT_CAPABILITIES: Readonly<{formatVersion: 1; kinds: readonly ['edit', 'create', 'move', 'delete']; atomicity: 'per-file'; recovery: 'readback-only'; limits: typeof WORKSPACE_EDIT_LIMITS}>;
export type WorkspaceEditChange = {readonly reason?: string} & (
  {readonly kind: 'edit'; readonly path: string; readonly baseRevision: string; readonly edits: readonly TextEdit[]} |
  {readonly kind: 'create'; readonly path: string; readonly content: string} |
  {readonly kind: 'move'; readonly path: string; readonly newPath: string; readonly baseRevision: string} |
  {readonly kind: 'delete'; readonly path: string; readonly baseRevision: string}
);
export interface WorkspaceEdit {readonly formatVersion: 1; readonly id: string; readonly title: string; readonly changes: readonly WorkspaceEditChange[];}
export interface WorkspaceEditFileState {readonly content: string; readonly revision: string;}
export interface WorkspaceEditPathState {readonly path: string; readonly state: WorkspaceEditFileState | null;}
export interface WorkspaceEditPreviewStep {
  readonly index: number; readonly before: readonly WorkspaceEditPathState[]; readonly after: readonly WorkspaceEditPathState[] | null;
  /** One UTF-16 replacement hunk. Full before/after snapshots remain available above. */
  readonly diff: readonly {readonly path: string; readonly change: {readonly start: number; readonly deleteCount: number; readonly insertText: string}}[];
}
export interface WorkspaceEditPreview {
  readonly formatVersion: 1; readonly planId: string; readonly digest: string;
  readonly workspace: {readonly id: string; readonly generation: string}; readonly edit: WorkspaceEdit;
  readonly requiredCapabilities: readonly ('write' | 'manage')[]; readonly ready: boolean;
  readonly conflicts: readonly {readonly path: string; readonly code: 'destination_exists' | 'source_missing' | 'revision_changed' | 'no_change'}[];
  readonly steps: readonly WorkspaceEditPreviewStep[];
}
export type WorkspaceEditObservedState = 'applied' | 'not-applied' | 'conflicted' | 'unknown';
export interface WorkspaceEditRecord {
  readonly formatVersion: 1; readonly preview: WorkspaceEditPreview; readonly revision: number;
  readonly phase: 'applying' | 'completed' | 'stopped'; readonly updatedAt: number;
  readonly steps: readonly {readonly state: WorkspaceEditObservedState | 'pending' | 'intent'; readonly errorCode?: WorkspaceErrorCode}[];
}
/** A trusted host port. Writes must persist before resolving; begin must reject reused plan IDs. */
export interface WorkspaceEditJournal {
  begin(record: WorkspaceEditRecord): Promise<void>;
  write(record: WorkspaceEditRecord): Promise<void>;
  read(planId: string): Promise<WorkspaceEditRecord>;
}
export interface WorkspaceEditReceipt {
  readonly formatVersion: 1; readonly planId: string; readonly digest: string; readonly workspaceId: string;
  readonly status: 'completed' | 'partial' | 'not-applied' | 'uncertain';
  readonly steps: readonly {readonly index: number; readonly state: WorkspaceEditObservedState; readonly canCompensate: boolean; readonly errorCode?: WorkspaceErrorCode}[];
  readonly executionStopped?: boolean; readonly errorCode?: WorkspaceErrorCode; readonly journalError?: WorkspaceErrorCode;
  readonly currentGeneration?: string; readonly journalPhase?: WorkspaceEditRecord['phase']; readonly journalRevision?: number;
}
export interface WorkspaceEditAuthorization {
  readonly planId: string; readonly digest: string; readonly workspace: WorkspaceEditPreview['workspace'];
  readonly requiredCapabilities: WorkspaceEditPreview['requiredCapabilities'];
  readonly phase: 'preflight' | 'before-change' | 'apply'; readonly index: number | null;
}
export interface WorkspaceEditApplyOptions extends WorkspaceRequestOptions {
  readonly reviewed: {readonly planId: string; readonly digest: string}; readonly journal: WorkspaceEditJournal;
  /** Current host policy for the exact reviewed plan, checked again for each operation. */
  readonly authorize: (request: WorkspaceEditAuthorization, options: {readonly signal?: AbortSignal}) => boolean | Promise<boolean>;
}
export function parseWorkspaceEdit(value: unknown): WorkspaceEdit;
export function parseWorkspaceEditPreview(value: unknown): WorkspaceEditPreview;
export function parseWorkspaceEditRecord(value: unknown): WorkspaceEditRecord;
export function parseWorkspaceEditReceipt(value: unknown): WorkspaceEditReceipt;
export function previewWorkspaceEdit(client: WorkspaceClient, edit: WorkspaceEdit, options?: WorkspaceRequestOptions): Promise<WorkspaceEditPreview>;
export function applyWorkspaceEdit(client: WorkspaceClient, preview: WorkspaceEditPreview, options: WorkspaceEditApplyOptions): Promise<WorkspaceEditReceipt>;
/** This is observational recovery, not a resume or retry operation. */
export function recoverWorkspaceEdit(client: WorkspaceClient, journal: WorkspaceEditJournal, planId: string, options?: WorkspaceRequestOptions): Promise<WorkspaceEditReceipt>;
export function createWorkspaceCompensation(preview: WorkspaceEditPreview, receipt: WorkspaceEditReceipt, options: {readonly id: string; readonly title?: string}): WorkspaceEdit | null;
