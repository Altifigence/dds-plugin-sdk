# Selected-file uploads

The 0.10 line adds opt-in uploads to a server-owned Node workspace.
Use a local Windows/Linux
filesystem with Node 22 or 24. The operator selects both the workspace and a
separate private staging directory; a client cannot choose a host absolute path.
This is an SDK host contract, not evidence of a DDS or Cloud product rollout.

```js
import {createWorkspaceServer} from '@altifigence/dds-plugin-sdk/workspace-node';
const server = await createWorkspaceServer({
  root: operatorWorkspace, workspaceId, token, notice,
  plugins: [{plugin, artifactSha256}], grants: ['workspace.write'],
  uploads: {
    directory: operatorStagingDirectory, principalId: 'operator-account',
    roots: ['input'], fileSystem: 'local',
  },
});
```

The staging directory must not overlap the workspace and its parent must exist.
Allowed roots must exist and be directories. Both the current plugin manifest
and host grants must include `workspace.write`; the artifact pin must match the
current configured plugin. A token represents the configured operator principal,
not a multi-user tenancy system. Use a different store/principal and server when
operators need isolation. No grant, token or consent is restored from disk.
`server.revokeUploads()` permanently revokes this server's upload store; a new
server generation and explicit configuration are required to enable it again.

## Send an explicitly selected file

```js
import {uploadFile} from '@altifigence/dds-plugin-sdk/uploads';
import {createNodeUploadSource} from '@altifigence/dds-plugin-sdk/uploads-node';
const source = await createNodeUploadSource({path: selectedAbsoluteFile});
const result = await uploadFile(client, source, {
  uploadId: crypto.randomUUID(), pluginId, artifactSha256,
  path: 'input/design.bin', expectedRevision: null,
  signal, onProgress: progress => renderProgress(progress),
});
console.log(result.commitReceipt.revision);
```

In a browser, use `createBrowserUploadSource(selectedFile)` from
`/uploads-browser` with the `File` supplied by your own file input. The adapter
does not open a picker or request permission. A caller-defined source can expose
`{byteLength, async read(offset, length, {signal})}`; every read must return exactly
the requested non-shared `Uint8Array`. The Node adapter binds the selected regular,
single-link file's inode, size and timestamps and rejects later changes.

`uploadFile` hashes the entire source before starting, then reads and sends at
most 64 KiB at a time, awaiting each saved reply. It allows four concurrent helper
calls and a maximum 30-minute deadline; each request is at most 30 seconds. It
does not load the whole file, retry, select a different source, or infer rollback.
Progress phases distinguish hashing, saved-prefix verification, uploading, committing and
committed state. Cancellation leaves any acknowledged private prefix available
for explicit recovery. A cancelled/failed commit can already have published the
file: query the upload to learn its actual result.

Use the [transfer queue](TRANSFER_QUEUE.md) to schedule multiple selected uploads
and downloads with bounded retry, rate limits and pause at chunk boundaries.

## Low-level protocol and recovery

`getUploadCapabilities()` discovers the optional store, roots and budgets.
Known SDK 0.3–0.9 hosts return disabled without a new-method probe. Existing
`writeFile` remains a bounded UTF-8 API with its original behavior.

1. `beginUpload(spec)` accepts `uploadId`, `pluginId`, `artifactSha256`, relative
   `path`, `byteLength`, whole `sha256`, and `expectedRevision`.
2. `writeUploadChunk(reference, {offset, data, sha256})` accepts canonical base64
   and the chunk digest. Append at the verified offset; an identical range wholly
   inside the saved prefix is idempotent. Gaps, crossing overlaps and changed
   retransmissions are rejected. Empty files use the SHA-256 of zero bytes.
3. `queryUpload({uploadId, pluginId, artifactSha256, recover: true})` explicitly
   adopts the record into the current host generation after checking live grants.
   Old references cannot write on the new generation. A receiving prefix is
   rehashed from disk; a matching prefix with an uncheckpointed tail is truncated
   back to the saved offset. Missing or changed prefix bytes become `corrupt`.
4. `commitUpload(reference)` requires all bytes, matching whole hash, and the
   original target revision. `expectedRevision: null` means create-if-absent.
5. `abortUpload(reference)` discards a receiving private part. It returns a
   committed or uncertain record unchanged and never claims to undo publication.

Retain the caller's upload ID and complete selection. After reconnecting with
current authority, call `uploadFile(client, source, {...selection, recover: true})`.
The helper compares every spec field and rehashes the saved source prefix before
sending more bytes. A different file/destination needs a new upload ID. It never
restores an old client connection or silently restarts an expired upload.

## Commit and crash semantics

The store uses a single-writer PID/host lock, workspace/root/principal identity,
checksummed metadata, file synchronization, and atomic checkpoint renames. Commit
runs in the same SDK mutation queue as text writes. It records its intent and a
staging inode before copying, verifies the complete staging bytes, rechecks the
target's content revision, publishes, reads the final file back, records the
receipt, and removes the private part. The brief workspace staging name is
reserved and excluded by workspace listing, observation and search path rules.

After a crash or lost reply, a recorded staging inode at the destination plus its
full content hash proves publication; the query can complete the receipt. A
known uncommitted staging file is removed and the upload returns to receiving.
Otherwise the state is `uncertain`: it consumes capacity and needs operator
inspection. Receipt verification describes the bytes at commit/recovery time,
not a promise that the final workspace file will never change afterwards.

These guards are not an OS atomic compare-and-swap against uncooperative external
processes or an OS sandbox. Network filesystems are unsupported. Linux directory
fsync is attempted; Windows file sync and rename do not certify power-loss
durability. Failed/unknown metadata or orphaned files fail closed or remain for
operator inspection. Automatic cleanup never deletes unrecognized entries.
`recoverStaleLock: true` only recovers a definitely dead PID on the same machine;
live, remote or unverifiable writers are rejected.

## Budgets and lifetime

| Budget | Default | Maximum |
| --- | ---: | ---: |
| One file | 128 MiB | 1 GiB |
| Private reserved bytes | 256 MiB | 4 GiB |
| Records / active transfers | 64 / 4 | 64 / 4 |
| One chunk | 64 KiB | 64 KiB |
| Record retention | 1 hour | 24 hours |
| Pending operations | 16 | 16 |
| Record metadata / roots | 16 KiB / 16 | 16 KiB / 16 |

`/uploads-node` also exports `createNodeUploadStore`. It requires a concrete
writable Node workspace and a synchronous `authorize(spec)` callback returning
`true` on every current check. It exposes `begin/query/write/commit/abort`,
`capabilities/inspect`, explicit expired-record `prune`, `revoke`, and `close`.
The HTTP server owns and closes its configured store. Expired receiving parts are
removed when observed; committed/aborted records retain their receipt/idempotency
identity until explicit pruning or retention cleanup. Uncertain commits are never
automatically pruned. Inspect `reservedBytes`, `records`, `active`, `orphans` and
`directoryFsync` when managing an operator-owned store.

Run `npm run example:uploads` for an 8 MiB binary upload, cancellation after the
first chunk, host restart, explicit recovery, job artifact registration, and the
existing Node downloader's stored-byte verification. `npm run benchmark:uploads`
uses 2 MiB and 16 MiB inputs and reports chunk counts, hashes, RSS and elapsed time.
`npm run example:uploads-browser` prints a loopback browser URL. Choose a disposable
file or the generated sample, test cancellation, then resume and compare upload
and OPFS stored-download digests. Use **Stop fixture and clean up** when finished.
Tests cover duplicate/gap/overlap chunks, stale CAS, empty/corrupt input, changed
sources, quota/expiry, revoked authority, link guards and publication recovery.

The 2026-10-04 Windows Chromium 154 fixture verified a 2,097,169-byte browser File:
cancel after 65,536 saved bytes, reconnect and resume, commit, then 33 download
chunks with OPFS readback. Both digests were
`00036557522eb8b3daccbc4ff57016c64cacc37ea49e840a17b324bccc110bbc`.
That run took 14.8 seconds and the downloader's maximum measured chunk work was
18.9 ms. These are fixture measurements, not platform-wide performance promises;
native pickers, Firefox and Safari were not qualified by this run.

## 한국어 요약

0.10 API는 운영자가 선택한 workspace·별도 staging·root·principal을
사용합니다. 현재 플러그인 패키지 해시와 선언/승인된 workspace.write를 매번
확인하고, 부분 파일은 작업 파일로 노출하지 않습니다. Node에서 선택한 파일
또는 브라우저 File을 전체 사전 해시한 뒤 최대 64 KiB씩 전송합니다.

재시작 뒤에는 현재 권한으로 queryUpload의 recover를 명시하고 원본 prefix를
다시 검증합니다. 전체 크기·해시·expectedRevision을 확인한 뒤 확정하며, 응답
유실은 조회로 확인해야 합니다. 불명확한 확정은 uncertain으로 보존합니다.
기존 텍스트 writeFile과 구형 호스트의 계약은 유지합니다. 실제 DDS/Cloud UI
연결과 제품 출시는 별도 릴리스 범위입니다.
