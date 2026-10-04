# Caller-owned transfer queue

The 0.10 development checkout adds `/transfer-queue` for uploads, live binary job
downloads and stored artifact downloads. The published 0.9 archive does not include
it. Node and browsers share the queue and the same chunk/whole-file verifiers used
by `uploadFile`, `streamJobBinaryArtifact` and `streamStoredJobArtifact`.

```js
import {createTransferQueue} from '@altifigence/dds-plugin-sdk/transfer-queue';
const queue = createTransferQueue({
  concurrency: 2, perConnection: 1, bufferBytes: 131072,
  bytesPerSecond: 1048576, attempts: 3,
});
const unsubscribe = queue.subscribe(snapshot => render(snapshot));
const upload = queue.enqueueUpload(client, selectedSource, {
  uploadId: crypto.randomUUID(), pluginId, artifactSha256,
  path: 'input/design.bin', expectedRevision: null,
});
const download = queue.enqueueDownload(client, approvedReference, {sink});
upload.pause(); // current chunk may finish before state becomes "paused"
upload.resume();
const [saved, received] = await Promise.all([upload.result, download.result]);
queue.release(upload.id);
unsubscribe();
await queue.dispose();
```

Use `enqueueStoredDownload(client, currentStoredReference, {sink})` for a stored
snapshot. All references must belong to the client's current workspace generation.
Queue admission captures the current connection. It never reconnects, restores
tokens/grants, chooses files, opens a picker, or enlarges a workspace root.

## Scheduling and limits

| Option | Default | Maximum / meaning |
| --- | --- | --- |
| `maxTransfers` | 32 | 32 retained entries, including terminal results |
| `concurrency` | 4 | 4 simultaneous bounded stages across this queue |
| `perConnection` | 2, capped by concurrency | 4 stages for the same client binding |
| `bufferBytes` | 262144 | 65536–262144, a multiple of 65536 |
| `bytesPerSecond` | 0 | 0 disables limiting; otherwise raw payload bytes/sec |
| `attempts` | 3 | 1–5 attempts per retryable chunk, including the first |
| `baseDelayMs` | 100 | 1–1000 ms |
| `maxDelayMs` | 2000 | base delay through 10000 ms |

Every source-hash chunk, network chunk plus sink write, and stored-readback chunk
yields the execution slot. There is one pending stage per transfer. Effective
concurrency is at most `bufferBytes / 65536`; no next network chunk is requested
before the sink accepts the current one. `peakChunkBytes` is this conservative
decoded-payload admission bound, **not** a measurement of total process memory.
HTTP JSON/base64 strings, hashing state, runtime overhead and trusted caller ports
consume additional memory. A caller sink must avoid unbounded buffering and must
cooperate with cancellation. Multiple queues have independent budgets.

Ready stages are ordered by their ticket minus priority (0–3; default 0). Priority
has a bounded head start: newly arriving high-priority work cannot indefinitely
overtake old eligible work. A saturated connection is skipped; other connections
can proceed. A retry's backoff releases its stage slot. The upload host's advertised
active-session limit also gates begin/recovery for the same connection. Uploads
already held by other queues/clients can still cause the host to reject admission.

The shared rate bucket allows an initial burst of 64 KiB. Each scheduled network
attempt, including retries, consumes raw payload tokens. With a configured rate R,
charged bytes over elapsed time T are bounded by `65536 + R*T`. It is not an HTTP
wire-bandwidth meter: JSON/base64 overhead is excluded. An older waiting network
stage reserves its turn while tokens accumulate (at most one chunk); token-free
hashing/verification can continue. Slow caller I/O is non-preemptible until it
settles. The example reports actual small/large completion times; it does not
promise a completion latency for arbitrary files, hosts or paused sessions.

The queue retains at most 32 entries and 16 synchronous listeners. It buffers no
event history. `list()` returns current frozen snapshots, and `subscribe()` returns
an unsubscribe function. Listener failures are isolated and counted by `inspect()`.
Release terminal entries explicitly. A released handle cannot control a new entry
with the same ID. `dispose()` cancels unfinished transfers and resolves only after
their cooperative cleanup; it also removes subscriptions.

## State, pause, cancellation and recovery

States are `queued`, `running`, `paused`, `completed`, `failed`, `cancelled`.
`running` means a started transfer, while `active` identifies an executing stage.
`pauseRequested` can be true during the final in-flight stage. Pause takes effect
at its next boundary, preserves hashes and open sink/session state in memory, and
does not abort an HTTP request. If the last stage completes, the result may become
completed despite a simultaneous pause request. `resume()` uses the same source,
sink and client generation. Paused uploads keep their server receiving session;
their expiry and the overall deadline continue advancing.

`cancel()` and `dispose()` abort active requests. They do not roll back committed
files. An upload's acknowledged prefix remains in its private store; cancellation
does not call `abortUpload`. Releasing a queue entry also does not remove that
server record. Use the upload API explicitly if deletion of a known private
session is intended. Failed/cancelled downloads follow their sink's abort policy:
the browser on-commit sink discards uncommitted bytes, while a retaining caller
sink can keep a partial. `partialDisposition` is `unknown` until evidence exists.

Queue pause/resume is scoped to this live JavaScript instance. After cancellation,
host restart or page reload, create a new approved client and a new transfer. For
uploads, explicitly choose `recover: true` with the same selection. The helper
queries current authority and rehashes the source's saved prefix before sending
new bytes. Persistent browser download recovery is a separate 0.10 integration
feature; this queue alone does not persist sink handles or checkpoint metadata.

The optional per-transfer `timeoutMs` is at most 30 minutes and includes queue
wait, retry backoff and pause. Request timeouts are at most 30 seconds. Callers
must cooperate: JavaScript cannot forcibly terminate an arbitrary sink promise.

## Retry and verified progress

Only identical upload chunks and reference/range-bound artifact reads are retried,
and only when the SDK HTTP client classified HTTP 429, HTTP 503, network transport
failure or its own request timeout. Delay doubles up to the configured maximum
with 50–100% jitter. The attempt count and whole-transfer deadline bound retries.
Status codes alone do not authorize replay; generic quota errors, permission/auth
failures, checksum/range validation, conflicts and changed connections fail
immediately. A changed source is rejected before retrying an upload chunk.

Begin, recovery query, commit and caller sink operations are not automatically
replayed. A lost commit response is `commit: "unknown"` until an explicit query or
recovery proves the durable result. Retrying the whole transfer is not implicit.

| Field | Meaning |
| --- | --- |
| `acknowledgedBytes` | Upload bytes saved by the host, or download bytes accepted by the sink |
| `resumedBytes` | Saved upload prefix found at explicit recovery |
| `transferredBytes` | Newly acknowledged bytes, excluding that prefix |
| `attemptedBytes` | Raw payload bytes admitted for network attempts, including failed attempts |
| `retriedBytes` | Portion admitted after a chunk's first attempt |
| `remainingBytes` | Total minus acknowledged bytes |
| `phase` | Preparation, hashing, prefix verification, transfer, commit or storage verification |
| `verified` | True only when a validated final receipt completed the transfer |
| `verification` | `pending`, `received`, `stored`, or `upload-commit` |

Attempts are admission accounting, not a claim that every byte reached the peer.
Cancellation/source failure can stop an admitted attempt before its HTTP request.
100% acknowledged bytes can still fail whole-file hashing, commit or stored
readback. Keep the progress bar separate from final verified completion. The
resolved `handle.result` contains the full upload status or artifact receipt.

## Runnable evidence

`npm run example:transfer-queue` sends a selected Node file while downloading large
and small results to file sinks, pauses/resumes the upload, injects one HTTP 503
and one lost upload acknowledgement, and verifies full hashes. The example uses
a disposable host and cleans its temporary files. `npm run benchmark:transfer-queue`
reports 256 KiB/2 MiB timing, queue bounds, RSS and event-loop measurements.

Run `npm run example:transfer-queue-browser`, open the printed loopback URL, click
**Run mixed transfers**, then **Resume paused upload**. A generated `File` and
explicit disposable OPFS folder exercise the same mixed queue in the browser.
The page removes its OPFS folder after completion/cancellation. Use its **Stop
fixture and clean up** button to close the Node host and remove its temporary files.
Windows/Linux with Node 22/24 run the contract, failure and packed-consumer checks
in CI. Browser OPFS needs a supported secure context. These are SDK examples,
not a DDS/Cloud product deployment or a performance guarantee.

## 한국어 요약

`/transfer-queue`는 호출자가 연결한 client와 선택한 source/sink만 사용합니다.
전체·연결별 청크 동시성, 64 KiB 단위 메모리 예산, 속도, 재시도 횟수와 전체
기한을 제한합니다. 작은 파일이 진행되도록 청크마다 순서를 나누고 다른 연결의
포화와 재시도 대기는 실행 슬롯을 점유하지 않습니다. 호스트 업로드 세션 한도도
확인하지만 다른 client가 점유한 한도를 우회하지 않습니다.

일시정지는 현재 단계 다음 경계에서 적용되며 같은 실행 중에만 메모리 상태로
재개합니다. 취소해도 이미 확정된 파일을 되돌리지 않습니다. 서버의 저장된
업로드 prefix는 남고, 다운로드 partial은 sink의 정리 정책을 따릅니다. 새 연결의
업로드 복구는 `recover: true`로 명시하고 현재 권한과 prefix hash를 다시 검사합니다.

429/503·네트워크 오류·요청 timeout으로 실패한 동일 청크만 제한적으로 재시도합니다.
인증·권한·해시·범위·충돌 오류와 begin/commit은 자동 반복하지 않습니다. 진행률
100%와 `verified: true`를 구분하고 전송 시도·새 저장 바이트·재시도·기존 prefix를
별도로 표시합니다. 이 문서는 0.10 개발분이며 공개 0.9 archive에는 포함되지 않습니다.
