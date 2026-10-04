# Stored result files (SDK 0.8.0)

Enable the optional artifact store to keep verified text and binary results after
the source changes or disappears. It shares the Node job store's workspace
identity and single-writer lock. Existing text/binary APIs still refer to the
original source and generation. Stored results use separate methods and explicit
`storage: 'snapshot'` references.

## Enable retention

```js
import {createNodeJobStore} from '@altifigence/dds-plugin-sdk/job-storage-node';
import {createNodeArtifactStore} from '@altifigence/dds-plugin-sdk/artifact-storage-node';
import {createWorkspaceServer, downloadStoredJobArtifact} from '@altifigence/dds-plugin-sdk/workspace-node';

const store = await createNodeJobStore({directory, workspaceRoot: root, workspaceId});
const artifacts = await createNodeArtifactStore({jobStore: store});
const server = await createWorkspaceServer({
  root, workspaceId, token, notice,
  plugins: [{plugin, artifactSha256: verifiedPackageSha256}],
  grants: ['workspace.read'], jobs: true, binaryArtifacts: true,
  jobStorage: {store, artifacts},
});
```

The operator supplies absolute paths, a stable workspace ID, reviewed plugin
code and its package hash. Storage must be outside the project. The server binds
the real workspace identity; remote requests cannot select storage paths.
`binaryArtifacts: true` is needed for binary registration. Text registration
keeps its 256 KiB limit. The core host also accepts `jobStorage.artifacts` with
its explicit workspace identity and plugin hash map.

With retention enabled, `await job.addArtifact(...)` and
`await job.addBinaryArtifact(...)` copy bytes before publishing their artifact
entry. Each chunk and the full source stream are hashed; the actual staging
file is reread and hashed before publication. Partial, cancelled, changed or
over-budget copies do not produce a usable snapshot. The job checkpoint then
records the snapshot identity. A crash between file publication and the job
checkpoint can leave unreferenced bytes; it cannot authorize them through a
remote job lookup. No automatic rerun occurs.

Retaining bytes is a separate operator decision from metadata redaction. The
file can contain sensitive project results even when logs and command results
are omitted. Labels are omitted from stored metadata; paths, IDs, hashes and
sizes remain. Tokens, input secrets and old consent are never restored.

## Read and resume after restart

```js
// client is freshly connected to this server with the current token and grants.
const capabilities = await client.getArtifactStorageCapabilities();
const list = await client.listStoredJobArtifacts(pluginId, jobId, verifiedPackageSha256);
const reference = await client.getStoredJobArtifact(
  pluginId, jobId, artifactId, verifiedPackageSha256,
);
const receipt = await downloadStoredJobArtifact(client, reference, {
  destination: absoluteOutputPath, resume: true,
});
// For a text snapshot:
// const {content} = await client.readStoredJobArtifactText(textReference);
```

`list` distinguishes `source` references from `snapshot` metadata. Snapshot
availability is `retained`, `expired`, `missing`, `corrupt` or `unsupported`.
`retained` describes the loaded metadata index, not fresh proof that the file
exists. `getStoredJobArtifact()` verifies metadata and the full stored file,
then returns a reference bound to the current connection. Reads recheck file
identity and metadata, rehashing the whole file if its stat changes. Hashes
detect corruption; they do not authenticate an actor controlling the same OS
account and store directory.

Recovery and every read require the active plugin and command, matching package
digest and workspace identity, current `workspace.read`, and all recorded
grants. Authorization is checked again after asynchronous reads. A reconnect
must obtain a fresh reference; an old generation fails. The snapshot ID, store
ID and whole-file digest remain stable across restarts. Expired job metadata
also prevents remote file access even if the snapshot bytes remain on disk.

The Node downloader preserves an unverified `.dds-part` on interruption. With
`resume: true`, it hashes and checks that prefix against the freshly authorized
snapshot, then verifies chunks, the complete stream and the actual staging file.
It never overwrites an existing destination and requires filesystem hardlink
support for publication. A changed local prefix fails. No old permissions or
automatic command execution are used to resume. A stored download receipt adds
`storage`, `snapshotId` and `storeId` to the existing downloader receipt.
Browser consumers can read bounded chunks; they must verify their assembled
whole-file SHA-256. This release does not add browser disk resumption.

## Limits and operator lifecycle

| Limit | Default / maximum |
| --- | --- |
| Snapshot files, including invalid metadata | 256; operator may lower |
| Bytes per binary file | 1 GiB; operator may lower |
| Bytes per text file | 256 KiB |
| Stored blob, metadata and known temporary bytes | 256 MiB / 4 GiB |
| Retention from capture | 24 hours / 7 days |
| Decoded chunk / simultaneous reads | 64 KiB / 4 |
| Artifacts per job | Existing 16 combined text/binary entries |

Set `maxFiles`, `maxBytes`, `maxFileBytes` and `retentionMs` when opening the
store. A lower limit never silently deletes existing bytes; an over-budget store
fails to open. New retention settings apply to future captures; existing
`expiresAt` values remain fixed. Job-store quotas are separate.

`artifacts.inspect()` reports usage, records (including expiry times), expired
IDs, invalid/missing entries, active reader count and orphan count. An expiry
blocks a new read; a chunk already accepted can finish. Reader pins last for
each verify/chunk request, not an entire remote download. Between chunks,
explicit removal or expiry can stop the next request. Active job pins protect
their files through the final checkpoint.

`await artifacts.remove(snapshot)` removes one exact, unpinned record and its
bytes. `await artifacts.prune()` removes expired unpinned records, reporting
removed and retained IDs. `prune({orphans: true})` also removes recognized,
single-link temporary files and unpaired blobs. It never follows links or
deletes unknown names, corrupt metadata or ambiguous paired files. Inspect such
files as an operator; no remote deletion method is exposed. Job and artifact
pruning are independent, so removing a job need not erase its file immediately.

Finish operator maintenance calls, then close the server, artifact store and
job store in that order:

```js
await server.close();
await artifacts.close();
await store.close();
```

Files are synced and published without overwrite. Unix directory sync is used
where supported; Windows does not claim equivalent power-loss durability.
Process termination tests cover restart recovery, not power failure. A partial
hardlink publication can require operator repair. The job store's explicit
stale-lock recovery rules also apply to snapshots.

Known 0.7 and earlier hosts report this extension disabled without probes. An
explicit unsupported discovery also disables it; malformed/authentication/
transport failures do not trigger fallback. Missing snapshots never fall back
to a mutable source. HTTP methods are `snapshots.capabilities`, `snapshots.list`,
`snapshots.get` and `snapshots.read` in the existing authenticated envelope.
See the [real-process example](../examples/stored-artifacts/run.mjs),
[history](JOB_HISTORY.md) and [job storage](JOB_STORAGE.md).

## 한국어

호스트가 별도 보관 저장소를 켜면 결과 파일을 복사하고 전체 SHA-256과 실제 저장
파일을 검증합니다. 원본 삭제·수정이나 서버 재시작 후에도 현재 작업·플러그인·권한·
workspace를 다시 확인하여 새 참조로 읽을 수 있습니다. 원본 참조 API는 그대로
유지되며 보관본이 없을 때 원본으로 자동 전환하지 않습니다.

기본 한도는 256개, 총 256 MiB, 24시간입니다. 바이너리는 파일당 최대 1 GiB,
텍스트는 256 KiB이며 읽기는 최대 64 KiB씩 수행합니다. `.dds-part` 이어받기는
현재 참조로 부분 파일과 전체 결과를 다시 검증합니다. 보관 파일의 내용은 로그
마스킹과 별도로 저장되므로 운영자가 보관 여부와 기간을 선택해야 합니다.

사용량·만료·누락·손상·orphan은 `inspect()`로 조회하고 제거와 정리는 명시적으로
실행합니다. 진행 중인 읽기는 해당 분할 요청 동안 보호되며 분할 요청 사이에
만료·제거되면 다음 읽기는 거부됩니다. 작업 재실행은 별도 새 입력·새 ID가 필요하고
재시작이나 다운로드가 자동 실행을 유발하지 않습니다.
