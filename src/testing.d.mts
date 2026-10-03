import type { DiagnosticsResult, Disposable, DocumentSnapshot, Permission, Plugin, RequestOptions, Scope } from './index.mjs';

export interface TestHost extends Disposable {
  activate(plugin: Plugin): Promise<Disposable>;
  setDocument(snapshot: DocumentSnapshot): DocumentSnapshot;
  requestDiagnostics(options?: RequestOptions): Promise<DiagnosticsResult>;
  deactivate(pluginId: string): void;
}
/** Runs trusted local modules in-process; this developer host is not a sandbox. */
export function createTestHost(options?: {readonly scope?: Scope; readonly grants?: readonly Permission[]}): TestHost;
