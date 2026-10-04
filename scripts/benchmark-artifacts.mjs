import {runBinaryArtifactExample} from '../examples/binary-artifacts/run.mjs';
const result = await runBinaryArtifactExample({fileBytes:8_388_625});
console.log(JSON.stringify({...result,measurement:'Binary result response bodies including base64; headers, TLS, discovery and job polling excluded. A 64 KiB interruption is resumed without retransmitting its prefix. Timing is a local fixture, not a throughput guarantee.',memory:'Source hashing, download and final disk verification process at most 64 KiB of file bytes per buffer; no whole-file allocation in the transfer path.'},null,2));
