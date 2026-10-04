import {runUploadExample} from '../examples/uploads/run.mjs';
for(const fileBytes of [2_097_169,16_777_233])console.log(JSON.stringify(await runUploadExample({fileBytes})));
