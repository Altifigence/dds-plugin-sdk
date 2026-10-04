# Optional job storage (0.8 development)

`/job-storage` adds a versioned host storage contract and recovery receipt.
`/job-storage-node` provides an optional local filesystem implementation. This
is the first part of 0.8 development; tagged 0.7 archives do not contain it.
Existing v1 jobs, snapshots, hello and artifact responses keep their shapes.
Hosts without storage retain their in-memory behavior.

```js
import {createPluginHost} from '@altifigence/dds-plugin-sdk';
import {createNodeJobStore} from '@altifigence/dds-plugin-sdk/job-storage-node';

const store = await createNodeJobStore({
  directory: '/operator/job-store', // existing real parent; outside the project
  workspaceRoot: '/operator/project',
  workspaceId: 'operator-project',
});
const host = createPluginHost({
  jobs: true,
  scope: {projectId: store.identity.workspaceId, sessionId: crypto.randomUUID()},
  grants: ['workspace.read'],
  jobStorage: {
    store,
    workspaceIdentity: store.identity.workspaceIdentity,
    pluginArtifacts: {'my-plugin': verifiedPluginPackageSha256},
  },
});
await host.activate(plugin);
const jobId = crypto.randomUUID();
host.startCommandJob('my-plugin', 'analyze', {}, {jobId});
await host.flushJobStore();
const recovery = host.recoverJob('my-plugin', jobId);
host.dispose();
await host.flushJobStore(); // flush cancellation before closing the owner store
await store.close();
```

Use absolute Windows paths on Windows. `plugin` and its verified package hash
are operator-reviewed inputs. A hash binds identity; it is not execution
approval or a sandbox. The complete [restart example](../examples/durable-jobs/run.mjs)
runs from a packed installation and checks clean exit and forced termination of
its own child process.

## Commit and recovery contract

The synchronous `startCommandJob`, `getJob` and event methods describe live
memory. With storage enabled, the provider waits for its initial intent
checkpoint before executing. Later changes are coalesced. `flushJobStore()`
waits for checkpoints requested before the call and rejects persistence or
redaction errors. It does not wait for the command to finish. A settled record
includes the terminal snapshot and retained event tail.

`recoverJob(pluginId, jobId)` reads the committed index. Its current response
scope is separate from the original scope inside `record.snapshot`:

| Disposition | Meaning |
| --- | --- |
| `live` | This host still owns the unsettled execution. |
| `completed` | A settled terminal checkpoint was committed; inspect the v1 state for success, failure, cancellation or timeout. |
| `interrupted` | A prior host left an unsettled checkpoint; its last v1 state is preserved. |
| `expired` | Retention passed; no record body is returned. |
| `missing` | No retained record exists for the ID. |
| `corrupt` / `unsupported` | The record cannot be accepted; no body is returned. |

`unrecordedTail: 'unknown'` means events after the committed sequence cannot be
proven. Only completed records report `'none'`. An interrupted job is never
mapped to a new v1 state or automatically rerun. Starting an ID already in the
store fails with `conflict`; a new execution needs a fresh ID. After explicit
removal/pruning the store can no longer recognize that ID.

Recovery requires an active plugin/command, current `workspace.read`, matching
package identity and every grant recorded for that execution. Stored grants
constrain recovery; they never confer authority. Tokens, consent records,
controllers, callbacks and raw command inputs are not serialized. Changes to
workspace ID, canonical root/inode, package hash or authorization are rejected.

## Content and limits

Default `metadata-only` storage omits result bodies, progress messages and
artifact labels. Log text becomes `[redacted]`. Sequences and event kinds remain.
A succeeded snapshot has `result: null`; `contentPolicy` identifies omission.
The optional trusted `redact(entry)` returns reviewed log/progress text or result
JSON. It must be synchronous and deterministic; `null` omits a field. Invalid
output or callback failures stop persistence and abort the job. The SDK cannot
detect arbitrary application secrets. Paths and plugin/command IDs remain
metadata. Artifact entries currently reference sources, not retained bytes.

| Limit | Default / maximum |
| --- | --- |
| Records including invalid entries | 256; operator may lower |
| Normalized record | 512 KiB |
| Committed record/backup bytes | 64 MiB; operator may lower |
| Retention from latest checkpoint | 24 hours / 7 days |
| Pending writes / flush waiters | 32 |
| Retained events | Existing 256 events / 64 KiB ring |

Atomic replacement temporarily needs one extra record's space; lock/metadata
files are additional small files. `inspect()` reports bytes, expired IDs, invalid
records and orphan/backup counts. Expiration hides a record from recovery.
`prune()` explicitly removes expired bytes; `remove(id, revision)` checks an
exact revision. Pins protect active jobs through their final checkpoint. Corrupt
records, unknown files, migration backups and incomplete temporary files are
never silently deleted. Direct port callers must await each `write()` result.

## Filesystem and schema behavior

The Node store needs a dedicated real directory outside the workspace and a
real existing parent. Bounded reads, root identity, single-link regular files
and SHA-256 envelopes reject path/link/replacement attacks and corruption. One
bad record does not hide valid neighbors. Checksums are not authentication
against an actor with access to the same account; protect the directory with OS
permissions. The synchronous index is loaded and verified when opening; writes
recheck disk ownership and the prior record before replacement.

Writes create an exclusive temporary file, sync its contents, rename it over the
checkpoint and recheck ownership. Supported Unix directories are also synced.
Windows reports `file-sync-and-rename`, without claiming equivalent directory
sync or power-loss guarantees. Failure after rename may leave a complete newer
file; reopen and inspect instead of assuming rollback. The example tests process
interruption, not power loss.

Only one `.writer.lock` owner can open a local store. Active or ambiguous owners
fail closed. `recoverStaleLock: true` explicitly permits reclaim only for a
demonstrably dead same-machine PID; concurrent reclaimers use a separate guard.
A leftover guard, reused/live PID, unreadable lock or replaced directory needs
operator inspection. No process is killed. Network filesystems and hostile
same-account processes are outside this locking guarantee.

Record schema version is 1. Unknown versions return `unsupported`. No earlier
tagged SDK had a durable format. An optional operator `migrateLegacy` adapter can
import an owned version-zero format: validate v1 output, preserve exact original
bytes in an exclusive `.legacy-backup`, then atomically replace. Failed conversion
keeps the original. Migration is opt-in and never restores permissions as grants.

## 한국어

0.8 개발 단계의 선택적 작업 저장 계약입니다. 초기 기록이 저장되기 전에는 명령을
실행하지 않으며, `flushJobStore()`는 호출 시점까지 요청한 기록의 저장을 확인합니다.
작업 완료를 기다리는 API는 아닙니다. 재시작 복구는 현재 플러그인·명령·권한·패키지
해시를 다시 확인하고 완료·중단·만료·손상·미지원 상태를 구분합니다. 중단된 작업을
자동 실행하지 않으며 마지막 기록 이후의 불확실성은 `unrecordedTail`로 알립니다.

입력·토큰·이전 동의는 저장하지 않습니다. 로그·진행률 메시지·결과도 기본 제외되며
운영자의 결정적인 마스킹 함수가 검토한 값만 보관할 수 있습니다. 이 단계의 파일
정보는 원본 참조입니다. 실제 프로세스 종료를 검증하지만 전원 손실은 보장하지 않습니다.
