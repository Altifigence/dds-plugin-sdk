import { createPluginHost } from './host.mjs';

/** Executes trusted local plugins in-process with the original diagnostics defaults. */
export function createTestHost({scope, grants = ['document.read', 'diagnostics.publish']} = {}) {
  return createPluginHost({hostId: 'test-host', scope, grants});
}
