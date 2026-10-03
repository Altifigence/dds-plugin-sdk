import type { Permission, PluginHost, Scope } from './index.mjs';

export interface TestHost extends PluginHost {}
/** Runs trusted local modules in-process; this developer host is not a sandbox. */
export function createTestHost(options?: {readonly scope?: Scope; readonly grants?: readonly Permission[]}): TestHost;
