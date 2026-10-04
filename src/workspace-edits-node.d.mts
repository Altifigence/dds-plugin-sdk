import type {WorkspaceEditJournal, WorkspaceEditRecord, WORKSPACE_EDIT_LIMITS} from './workspace-edits.mjs';
import type {WorkspaceErrorCode} from './workspace-protocol.mjs';
export interface NodeWorkspaceEditJournal extends WorkspaceEditJournal {
  readonly capabilities: Readonly<{formatVersion: 1; workspaceId: string; durability: 'file-fsync-rename'; directoryFsync: boolean; singleWriter: true; limits: typeof WORKSPACE_EDIT_LIMITS}>;
  list(): Promise<readonly ({readonly planId: string; readonly available: true; readonly phase: WorkspaceEditRecord['phase']; readonly revision: number} | {readonly planId: string; readonly available: false; readonly errorCode: WorkspaceErrorCode})[]>;
  close(): Promise<void>;
}
export function createNodeWorkspaceEditJournal(options: {readonly directory: string; readonly workspaceRoot: string; readonly workspaceId: string; readonly recoverStaleLock?: boolean}): Promise<NodeWorkspaceEditJournal>;
