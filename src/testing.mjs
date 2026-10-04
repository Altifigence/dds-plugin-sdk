import { createPluginHost } from './host.mjs';
export {createTestClock,flushTestMicrotasks,createTestResources,TEST_LIMITS,TEST_RESOURCE_KINDS} from './testing-runtime.mjs';
export {createFaultController,TEST_FAULTS} from './testing-faults.mjs';
export {createMemoryWorkspace} from './testing-workspace.mjs';
export {createScenarioHost} from './testing-scenario.mjs';
export {createMemoryJobStore} from './testing-job-store.mjs';
export {createTestRecorder,createTestReplay,parseTestTrace,TRACE_OPERATIONS} from './testing-trace.mjs';

/** Executes trusted local plugins in-process with the original diagnostics defaults. */
export function createTestHost({scope, grants = ['document.read', 'diagnostics.publish']} = {}) {
  return createPluginHost({hostId: 'test-host', scope, grants});
}
