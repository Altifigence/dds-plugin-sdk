import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {runStreamingArtifactExample} from '../examples/browser-artifacts/run.mjs';
const visited=new Map();
async function visit(url){
  if(visited.has(url.href))return;
  const source=await readFile(url,'utf8');visited.set(url.href,source);
  for(const match of source.matchAll(/(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/g)){
    assert.ok(match[1].startsWith('./'),'Browser graph must contain only local ESM imports');await visit(new URL(match[1],url));
  }
  assert.ok(!/\b(?:require\s*\(|import\s*\(\s*['"]node:)/.test(source),'No Node runtime bridge in browser modules');
}
await visit(new URL('../src/artifact-transfer.mjs',import.meta.url));await visit(new URL('../src/artifact-transfer-browser.mjs',import.meta.url));
const transferSource=[...visited.values()].join('\n'),rawBytes=Buffer.byteLength(transferSource),gzipBytes=gzipSync(transferSource).length;
assert.ok(rawBytes<250_000&&gzipBytes<60_000,'Browser transfer graph exceeded its initial regression budget');
const small=await runStreamingArtifactExample({fileBytes:2_097_169});
const large=await runStreamingArtifactExample({fileBytes:16_777_217});
for(const result of [small,large]){assert.equal(result.peakQueuedChunks,1);assert.ok(result.peakDecodedBytes<=65536);assert.equal(result.receivedSha256,result.storedSha256);}
console.log(JSON.stringify({browserModules:visited.size,rawBytes,gzipBytes,budgets:{rawBytes:250000,gzipBytes:60000,queuedChunks:1,decodedChunkBytes:65536},samples:[small,large],note:'RSS includes client, HTTP host, JIT and GC. Timing and RSS are observations, not portable hard bounds.'},null,2));
