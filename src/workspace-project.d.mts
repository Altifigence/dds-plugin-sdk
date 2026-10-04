import type {Range} from './index.mjs';
import type {WorkspaceClient, WorkspaceRequestOptions} from './workspace-client.mjs';
import type {WorkspaceHello, WorkspaceEntry} from './workspace-protocol.mjs';
import type {WorkspaceFileWatchOptions, WorkspaceFileChange, WorkspaceObserver} from './workspace-observation.mjs';

export interface TextEdit {readonly range: Range; readonly text: string;}
export interface EditSnapshot {readonly path: string; readonly content: string; readonly revision: string;}
export interface WorkspaceEditSession {
  readonly snapshot: EditSnapshot;
  readonly state: 'ready' | 'saving' | 'reloading' | 'needs-reload' | 'disposed';
  save(content: string, options?: WorkspaceRequestOptions): Promise<EditSnapshot>;
  saveEdits(edits: readonly TextEdit[], options?: WorkspaceRequestOptions): Promise<EditSnapshot>;
  reload(options?: WorkspaceRequestOptions): Promise<EditSnapshot>;
  dispose(): void;
}
export interface WorkspaceProject {
  getProjectCapabilities:WorkspaceClient['getProjectCapabilities'];
  getProjectSnapshot:WorkspaceClient['getProjectSnapshot'];
  listTree:WorkspaceClient['listTree'];
  searchFiles:WorkspaceClient['searchFiles'];
  searchText:WorkspaceClient['searchText'];
  releaseProjectQuery:WorkspaceClient['releaseProjectQuery'];
  watchProject:WorkspaceClient['watchProject'];
  readonly workspace: WorkspaceHello['workspace'];
  /** Observe explicit file revisions without replacing edit-session snapshots. */
  watchFiles(paths: readonly string[], options?: WorkspaceFileWatchOptions): WorkspaceObserver<WorkspaceFileChange>;
  listFiles(path?: string, options?: WorkspaceRequestOptions): Promise<{entries: readonly WorkspaceEntry[]}>;
  openFile(path: string, options?: WorkspaceRequestOptions): Promise<WorkspaceEditSession>;
  /** Create-if-absent (expectedRevision=null). It never overwrites an existing file. */
  createFile(path: string, content: string, options?: WorkspaceRequestOptions): Promise<WorkspaceEditSession>;
  /** Dispose owned edit sessions; the caller retains ownership of the underlying client. */
  dispose(): void;
}
export function applyTextEdits(content: string, edits: readonly TextEdit[]): string;
export function createWorkspaceProject(client: WorkspaceClient): WorkspaceProject;
