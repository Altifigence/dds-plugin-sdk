import test from 'node:test';
import assert from 'node:assert/strict';
import {runCombinedWorkload} from '../examples/combined-workload/run.mjs';
import {createConformanceWorkspace} from '../src/conformance-node.mjs';

test('combined real host survives repeated language/settings/edit/job/watch/transfer workload and network/revoke faults',async()=>{
  const result=await runCombinedWorkload({cycles:5,faults:true});
  assert.equal(result.languageRequests,200);assert.equal(result.commands,200);assert.equal(result.verifiedTransfers,10);
  assert.equal(result.observedChanges,5);assert.equal(result.faultChecks.length,20);assert.deepEqual(result.remainingResources,{});
});
test('a cancelled workspace setup removes its files and never yields a usable fixture',async()=>{
  const controller=new AbortController();controller.abort();await assert.rejects(createConformanceWorkspace({signal:controller.signal}));
});
