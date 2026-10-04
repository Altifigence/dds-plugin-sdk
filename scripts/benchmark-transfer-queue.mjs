import {runQueueExample} from '../examples/transfer-queue/run.mjs';
for(const fileBytes of [262_161,2_097_169])console.log(JSON.stringify(await runQueueExample({fileBytes})));
