# Browser artifact streaming (0.10 development)

The public 0.9 archive does not contain these APIs yet. This foundation is part of
the next 0.10 release. Existing Node file downloads remain available unchanged.

`/artifact-transfer` imports no Node built-ins. `streamJobBinaryArtifact()` uses
the existing 0.7 binary protocol; `streamStoredJobArtifact()` uses the 0.8 snapshot
protocol and requires a **fresh, currently authorized** stored reference. Neither
API restores credentials, grants, connections or host jobs.

```js
import {streamJobBinaryArtifact} from '@altifigence/dds-plugin-sdk/artifact-transfer';
import {createOpfsFileSink} from '@altifigence/dds-plugin-sdk/artifact-transfer-browser';

// This choice belongs to the application. The SDK never selects a directory.
const originRoot = await navigator.storage.getDirectory();
const chosenDirectory = await originRoot.getDirectoryHandle('my-results', {create: true});
const sink = await createOpfsFileSink(chosenDirectory, 'trace.bin', {overwrite: false});
const receipt = await streamJobBinaryArtifact(client, reference, {
  sink, signal: controller.signal,
  onProgress(update) { renderProgress(update); }, // synchronous; no retained chunks
});
if (receipt.verification === 'stored') showStoredHash(receipt.storedSha256);
```

For a user-visible file, the application obtains its own file handle and passes
it to `createBrowserFileSink(handle, {overwrite: true|false})`. The SDK only queries
existing `readwrite` permission. It never opens a picker, requests permission, or
falls back to OPFS, a download folder, another file or another origin. A denied
or revoked permission terminates the transfer. `overwrite: false` requires an
empty selected file. OPFS creation can leave an empty named file after failure.

## Bounded transfer and verification

One decoded chunk (at most 64 KiB) is handed to a sink at a time. Each write is
awaited before the next read. No complete-file `Blob` or `ArrayBuffer` is built.
The SHA-256 state retains a 64-byte block, 64-word schedule and eight words. The
helper yields a task between chunks, enforces a 1 GiB file limit, four concurrent
transfers per module instance and a 30-minute maximum total deadline. Request
deadlines use the existing client limit (30 seconds maximum). Suspended tabs can
delay execution; the absolute deadline is checked again when execution resumes.

Chunk identity, exact requested range, canonical base64, EOF and chunk SHA-256
are checked before writing. The incremental whole-file SHA-256 must equal the
reference before committing. The browser adapters then open a fresh `File`
snapshot and hash bounded slices of the saved bytes. This is readback evidence,
not a promise about hardware durability or future external modifications.

`receipt.verification` is `received` for a sink with no readback. In that case
`storedSha256` is `null`; it must never be displayed as a verified disk copy.
For readback sinks it is `stored`, and both hash fields equal the reference.
`onProgress` reaches all bytes before verification finishes. Only the completed
event and returned receipt set `verified: true`. Callback exceptions fail the
operation, even if commit has already happened.

The trusted caller sink contract advertises `seek`, `readback`, `persistence`
(`none`, `on-commit`, `per-checkpoint`) and abort behavior. The current core writes
sequentially from zero; advertising seek or checkpoints does not enable resume.
Implementations must bound retained data and cooperate with cancellation. The
helper waits for in-flight writes before cleanup so late writes are not detached.

## Failure and persistence

`ArtifactTransferError.partial` reports received/written counts, receive/readback
verification, commit state (`not-committed`, `unknown`, `committed`) and the known
partial disposition. A failed commit response is `unknown`; cancellation cannot
undo a completed commit. A readback mismatch can occur after a file is visible.
Do not retry permission, checksum or conflict failures automatically.

The asynchronous browser adapters stage writes until `close()` and discard that
staging stream on pre-commit failure. They do not provide a persistent partial
download after a reload. Normal intervening file changes are checked using size
and last-modified values; browser APIs provide no atomic compare-and-swap against
external programs. Reservations prevent concurrent use of the same entry only
within this module instance/realm. Cross-tab persistent recovery is a separate
0.10 integration step and is not claimed by this foundation.

## Examples, support and resource evidence

Run `npm run example:browser-artifacts` and use the displayed loopback URL.
The example creates a real 8 MiB binary through an explicitly configured local
host, downloads to a new selected OPFS subdirectory, verifies stored bytes and
removes only its generated fixture. It includes main-thread, Dedicated Worker,
cancellation and optional file-picker paths. The Worker isolates hashing from
the main thread. Applications decide whether and how to create their Worker.

`getBrowserArtifactStorageSupport()` reports feature presence, not qualification.
The runtime requires a secure context (including supported loopback contexts),
ES modules, typed arrays, `AbortController` and writable file handles. Missing
storage APIs return `unsupported`; no alternative destination is selected.
External file pickers and permission prompts need separate testing on each
browser/OS. Fake-handle tests cover denied/revoked access, quota errors and races;
they do not certify a native picker or disk-full behavior.

`npm run benchmark:browser-artifacts` runs 2 MiB and 16 MiB real file/HTTP cases,
records RSS and event-loop observations, and verifies the browser import graph
contains no Node runtime import. Regression budgets are 250,000 source bytes,
60,000 gzip bytes, one queued chunk and 65,536 decoded bytes. These graph sizes
are unbundled ESM source totals, not a tree-shaken application bundle. RSS includes
the test host, client, JIT and garbage collector; the logical chunk bound is not
a bound on total browser process memory. `maxChunkWorkMs` measures synchronous
core validation/hash elapsed time, including runtime scheduling pauses; the
browser example additionally reports long tasks.

Initial local verification (2026-10-04, Windows, embedded Chromium 154):

| Path | Result | Observed 8,388,625-byte transfer |
| --- | --- | --- |
| Window + OPFS writable stream | Passed receive and saved-file SHA-256 | 129 chunks; maximum core slice 18.5 ms; 14.51 s total; no recorded long tasks |
| Dedicated Worker + OPFS writable stream | Passed receive and saved-file SHA-256 | 129 chunks; repeat maximum core slice 21.2 ms; 9.82 s total |
| Window cancellation after first chunk | Passed | 65,536 bytes accepted into staging; not committed; staging discarded |
| User-visible native picker | Not qualified | Capability detected; actual picker/OS permission flow was not exercised |
| Firefox / Safari | Not qualified | Run the example on the intended browser and storage adapter |

The first Worker sample included a 6.22 s elapsed slice; the repeat is shown
above. These observations are not latency guarantees. Main-thread JS heap growth
was about 45.1 MB, including HTTP parsing and garbage collection. The transfer
ESM dependency graph measured 86,729 raw bytes / 21,832 gzip bytes on that checkout.
The real Node 2 MiB / 16 MiB examples also verified stored hashes with a one-chunk
queue; RSS growth was about 53.0 MB / 17.1 MB respectively (cold/warm runtime).

Semantics follow the [File System Standard](https://fs.spec.whatwg.org/) and the
[Chrome File System Access guide](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access).

## 한국어 요약

0.10 개발 단계 기능이다. 호출자가 선택한 파일/OPFS 디렉터리에만 저장하며
권한을 자동 요청하거나 다른 위치로 우회하지 않는다. 청크별 검증·저장을
기다린 뒤 다음 청크를 읽고, 수신 전체 해시와 저장 파일 재읽기 해시를 구분한다.
재읽기 없는 sink는 디스크 검증을 주장하지 않는다. 전체 바이트를 받았다는
진행률만으로 완료 처리하지 않는다. 취소·용량 초과·권한 철회·해시 오류에는
부분 상태와 확정 여부를 반환한다. 이 foundation의 비동기 저장은 새로고침 후
부분 파일 재개를 제공하지 않으며 영속 복구·탭 간 독점은 뒤의 0.10 통합 범위다.
