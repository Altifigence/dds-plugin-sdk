# Browser checkpoint recovery (0.10)

`/artifact-resume-browser` supplies a persistent OPFS sink for **stored artifacts**.
Use it in a dedicated Worker with a directory and UUID explicitly selected by the
application. A new or reconnected client must first obtain the same retained
snapshot with current host authority. The SDK never restores tokens, grants,
connections, commands, pickers or a previous host generation from local storage.

```js
// Inside an application-owned dedicated Worker:
import {createOpfsArtifactSink} from '@altifigence/dds-plugin-sdk/artifact-resume-browser';
import {streamStoredJobArtifact} from '@altifigence/dds-plugin-sdk/artifact-transfer';

await client.connect();
const reference = await client.getStoredJobArtifact(pluginId, jobId, artifactId, pluginPin);
const sink = createOpfsArtifactSink({directory: selectedDirectory, partialId, reference});
const receipt = await streamStoredJobArtifact(client, reference, {
  sink,
  resume: true, // false/omitted creates a new partial; an existing ID is a conflict
  signal: controller.signal,
});
showVerifiedHash(receipt.storedSha256);
```

The same options work with `queue.enqueueStoredDownload(client, reference, options)`.
The application selects its own directory and partial ID again after reload; the
sink does not enumerate origin storage or guess a previous download. The example
remembers only those two selections. An application must decide its own consent,
retention, storage persistence requests and deletion UI.

## Checkpoint format and ordering

`getOpfsArtifactPartialNames(partialId)` returns exactly two names:
`dds-partial-<UUID>.data` and `dds-partial-<UUID>.json`. Creation refuses an existing
data or metadata entry. Explicit recovery requires both entries; eviction or
deletion never causes a silent replacement download.
An interrupted first creation can leave an empty or orphan entry. Explicitly
inspect and remove that selected fixture, or choose a new ID; it is never reused
as an implicitly empty download.

The data file uses an exclusive `FileSystemSyncAccessHandle`. Each accepted chunk
is at most 64 KiB and is flushed before the small checksummed metadata is saved.
Metadata uses a separate writable stream, closed before acknowledging the chunk.
It records full immutable store/workspace/plugin-pin/job/snapshot/artifact
identity, timestamps, state and current/previous prefix offsets and hashes. It
contains no token, grants or old connection scope. `parseBrowserArtifactCheckpoint`
validates this bounded format; the JSON schema describes its structural contract.
The checksum detects accidental damage, not malicious changes by origin scripts.

On recovery the sink rehashes the recorded prefix in bounded slices. If the file
has extra uncheckpointed bytes, it truncates them only after that prefix matches.
If the current checkpoint is beyond the actual file size, the previous checkpoint
is considered only when its complete bytes exist and its hash matches. A corrupt
prefix, missing file, mismatched identity or invalid metadata fails without
resetting the download. The host's current reference must match the complete saved
snapshot; a new host generation is permitted through a fresh connection and grant.

The transfer helper independently rehashes the recovery prefix before asking for
remaining network bytes. Its final hash covers prefix plus new bytes, and its
stored verification re-reads the complete saved file. Recovering an already
complete partial still validates the host's EOF and rechecks saved bytes.
`resumedBytes` counts verified local prefix bytes; `receivedBytes` counts only this
attempt's network bytes. `verifying-prefix` is distinct from receive/commit/readback.
Only the returned verified receipt means that the whole transfer completed.

## Ownership, cancellation and bounds

An origin-wide exclusive Web Lock named `dds-artifact-partial:<UUID>` is requested
with `ifAvailable`. A competing tab receives `conflict`; no waiting queue, lock
stealing or takeover is attempted. The native data handle is also exclusive. Both
remain held through final readback, and cancellation closes them while retaining
the last checkpoint. Worker/tab termination releases native ownership; a later
explicit recovery validates the files again. This is cooperative same-origin
coordination, not an isolation boundary against other code executing in the origin.

Four open sink sessions per module instance, 1 GiB per file, 64 KiB per data
operation and 16 KiB per metadata record are hard maxima. The default local
retention is one hour; callers may choose up to 24 hours, capped by the retained
host snapshot's expiry. Every operation rechecks expiry. The transfer's separate
30-minute deadline includes queue wait and pause. Paused sessions retain locks,
and the fifth open checkpoint sink is rejected until a session closes.

There is no total origin-disk quota manager. Browser quota/eviction policy still
applies and can remove data. A data write or metadata-close failure poisons that
session; explicitly reopen to inspect whichever old/new checkpoint actually
persisted. Cancellation is not rollback. Cleanup belongs to the caller after
closing its session; no error path deletes unknown files or expired partials.

## Runtime and evidence

`getBrowserArtifactResumeSupport()` reports dedicated Worker, sync-access and Web
Locks presence. Native main-thread use is unsupported. Structural directory and
lock ports are trusted implementations useful for deterministic contract tests;
they do not establish native browser acceptance.

Run `npm run example:browser-resume`. The disposable host captures a 2 MiB result
and deletes its original source. In the page:

1. Create a checkpoint and stop; reload, restart the host, then resume.
2. Remove that completed fixture, create a new partial and hold its lock.
3. Open the same URL in a second tab and try recovery: it must report conflict.
4. Close the owning tab; retry recovery in the second tab and verify the full hash.
5. Remove the selected fixture files and stop the host.

Windows embedded Chromium 154 was exercised for checkpoint cancellation, page
reload, host restart, remaining-byte recovery, two-tab contention and owner-tab
termination. Other browsers and power-loss durability are not qualified by these
checks. Deterministic tests cover quota failures, metadata-close ambiguity,
truncated or damaged data, missing entries, expiry and identity changes; real HTTP
tests also cover fresh authority, revoked grants and source deletion.
The 2,097,169-byte reload/restart case reused 65,536 bytes and received 2,031,633
bytes in 32 chunks, with matching full SHA-256 in 3.67 seconds. The owner-tab
termination case took 4.31 seconds after selecting recovery. These are local
fixture observations, not portable latency guarantees.

The storage primitives follow the [File System Standard](https://fs.spec.whatwg.org/)
and [Web Locks specification](https://w3c.github.io/web-locks/). Writable metadata
becomes visible at close; sync data writes operate in place. These API semantics
do not promise operating-system power-loss durability or permanent browser storage.

## 한국어 요약

전용 Worker에서 사용자가 선택한 OPFS 디렉터리와 partial UUID로 중단된
다운로드를 재개한다. 새 연결이 현재 권한으로 얻은 저장 결과 참조와 로컬
메타데이터의 전체 identity를 비교하고, 실제 prefix를 다시 해시한 뒤 남은
바이트만 받는다. 손상·삭제·만료·다른 결과는 자동 초기화 없이 거부한다.
동일 partial의 다른 탭은 conflict를 받고, 소유 탭 종료 뒤 명시적으로 다시
복구한다. 취소는 검증된 체크포인트를 보관하며 token이나 이전 grants를
저장하지 않는다. 전체 수신·저장 재검증이 끝나야 완료로 표시한다.
