# Reviewed multi-file workspace edits

SDK 0.11 adds optional `prepare-rename` and `rename` language providers plus a
separate `@altifigence/dds-plugin-sdk/workspace-edits` client library. Providers
propose data. The caller previews the proposal, reviews its exact ID and digest,
and supplies current authorization before any workspace mutation. Existing
workspace HTTP protocol v1 read/write/rename/remove methods perform the file I/O.

Run `npm run example:workspace-edits`, or copy `examples/workspace-edits` from the
installed package and run its `run.mjs`. The example reads two explicitly selected
files, prepares a rename, shows an external-edit conflict, applies a newly reviewed
proposal, then kills a separate apply process at two checkpoints and reads back
exactly which files match the proposed changes. It uses disposable directories.

## Rename providers

Declare `prepare-rename` and/or `rename` in manifest v2, with `document.read` and
`language.provide` permissions granted by the host. Both requests require a document
position. `rename` also requires a nonempty `newName` of at most 256 UTF-16 units,
without control characters; each language decides whether that name is valid syntax.

`prepare-rename` returns `null` or `{range, placeholder}`. Its nonempty UTF-16 range
must contain the request position without splitting a surrogate or CRLF. `rename`
returns `null` or a `WorkspaceEdit`. Existing request identity, provider priority,
cancellation, pending limits and stale-result checks apply. Neither capability grants
file reads or writes. Supply only snapshots obtained through separately authorized
workspace reads. The teaching example passes such snapshots into a provider.

## Proposals, previews and approval

A proposal is `{formatVersion: 1, id, title, changes}` with a new UUID and one or
more changes. Each change has a relative `path`, optional plain-text `reason`, and:

| Kind | Required data | Conditions |
| --- | --- | --- |
| `edit` | `baseRevision`, `edits: [{range, text}]` | Revision must match; ranges refer to the original content |
| `create` | `content` | Destination must be absent |
| `move` | `newPath`, `baseRevision` | Source must match; destination must be absent |
| `delete` | `baseRevision` | Source must match |

Revisions are whole-content SHA-256 hashes. Paths must be disjoint, including move
destinations, with case-insensitive duplicate and ancestor/descendant rejection on
all platforms. Directory changes and dependent operation chains are unsupported.
Protected paths, traversal and link checks retain the existing workspace rules.
Content-identical edits are reported as `no_change` and cannot be applied.

```js
import {previewWorkspaceEdit, applyWorkspaceEdit}
  from '@altifigence/dds-plugin-sdk/workspace-edits';

const preview = await previewWorkspaceEdit(client, proposal);
// Present preview.steps, conflicts and requiredCapabilities to the user.
// Preserve the exact planId and digest approved by that review.
const receipt = await applyWorkspaceEdit(client, preview, {
  reviewed: approvedReview,
  journal,
  authorize: (request, {signal}) => currentHostPolicy(request, signal),
});
```

`client` is an explicitly connected authorized workspace client. `approvedReview`
contains the reviewed `{planId, digest}`; `currentHostPolicy` is a trusted host policy
that returns exactly `true` only while that review and required current capabilities
remain valid. Installing a plugin or receiving its suggestion is not approval.
The policy is checked before preflight and each change, including after the durable
intent checkpoint. Read-only hosts cannot apply. Moves/deletes require `manage`;
all changes require `write`. Existing server checks remain authoritative.

Previews contain full before/after file snapshots, required capabilities, conflicts
and one replacement hunk per affected path (`start`, `deleteCount`, `insertText`, in
UTF-16). Source hashes and all derived after content/diffs are verified. A canonical
SHA-256 binds the complete preview, proposal and workspace generation. A deserialized
preview is accepted only when it reproduces exactly; a changed field invalidates it.

Apply preflights **every** affected file before starting, then uses conditional
operations and checks each file again immediately before mutation. External edits
between those checks still face the existing per-file CAS. The existing local
filesystem adapter is a cooperative host, not protection against an adversarial
local process racing native filesystem calls. Multiple files are not an OS-atomic
transaction. One helper apply may run per client/journal port at a time.

## Journals and interrupted operations

`WorkspaceEditJournal` is a trusted host port with `begin`, `write` and `read`.
`begin` must reject a reused plan ID. Each method must persist before resolving.
The helper reads back each checkpoint before continuing. It records the complete
reviewed plan before any file change, records `intent` before each operation, and
records a verified applied receipt afterward. Journal failure stops further writes.
There is no automatic retry of an interrupted plan.

The Node adapter comes from `@altifigence/dds-plugin-sdk/workspace-edits-node`:

```js
const journal = await createNodeWorkspaceEditJournal({
  directory: selectedJournalDirectory,
  workspaceRoot: selectedWorkspaceRoot,
  workspaceId: client.binding.workspace.id,
});
// ...use this operator-owned journal...
await journal.close();
```

Both directory paths are operator-selected absolute paths. Journal storage must be
outside the workspace, with neither containing the other. The adapter binds the
logical workspace ID and canonical local directory identity. It uses a single-writer
lock, private regular files, checksum envelopes, file `fsync` and atomic checkpoint
rename. It rejects symlinks/hardlinks and detects changed roots. On Windows,
`directoryFsync` is false; do not infer power-loss durability for directory metadata.
The example verifies process termination, not power failure or network-filesystem
locking. Same-user malicious filesystem access is outside this trusted host boundary.

After a process dies, explicitly reopen with `recoverStaleLock: true`. Recovery
reclaims a lock only for a demonstrably dead PID on the same machine; a live or
uncertain owner is preserved. Reopening grants readback, not permission to resume
the old plan. Corrupt or incomplete records remain visible through `list()` as
unavailable; they are never repaired into executable plans. There is no automatic
eviction. Operators own retention, backup and disposal of this sensitive source data.

`recoverWorkspaceEdit(client, journal, planId)` reads current files with the caller's
current connection. It may use a new generation of the **same** workspace, but apply
rejects an old-generation preview. For each step it reports `applied`, `not-applied`,
`conflicted` or `unknown`. These states compare current content with recorded before
and after states; they do not prove the historical absence of intermediate edits.
A durable applied receipt followed by original bytes is `conflicted`. Revoked read
access, unavailable files and uncertain observations yield `unknown`.

A lost response stops execution even if readback proves the change applied. Inspect
both `status` and `executionStopped`/`errorCode`/`journalError`. Cancellation and
timeouts do not prove that a remote operation stopped; recover again after it has
settled. Recovery never replays changes. `createWorkspaceCompensation` produces a
new inverse proposal only for steps currently reported applied. Preview and review
it anew: stale revisions, occupied move destinations or new files can block recovery
without overwriting someone else's work. File modes/timestamps are not restored.

## Bounds and compatibility

Limits are 32 changes, 500 edits per file, 1,000 edits total, 1 MiB serialized
proposal, 8 MiB preview and the existing 256 KiB per-file UTF-8 limit. Node journals
hold at most 64 plans and 64 MiB; incomplete checkpoint files count toward capacity.
Request/authority timeout defaults to 5 seconds, capped at 30 seconds. Apply has no
single total deadline; an abort signal can cancel the sequence. Trusted journal
ports must complete or fail their own persistence operations. Old hosts that expose
the original file methods remain usable; no new HTTP method is required.

## 한국어

이름 변경 제공자는 상대 경로와 기준 revision이 포함된 수정안만 제안합니다.
별도 호스트가 현재 승인 연결로 파일을 읽어 미리보기·변경 내용·충돌을 확인하고,
검토한 계획 ID/해시와 현재 쓰기/관리 권한을 확인한 뒤 적용합니다. 한 파일이라도
사전검사에서 달라졌으면 시작하지 않으며, 적용 도중 충돌하면 이후 변경을 멈춥니다.

여러 파일 전체의 원자성을 약속하지 않습니다. 작업 의도와 결과를 기록하고,
응답 유실·프로세스 종료 후 현재 파일을 읽어 적용/미적용/충돌/불확실을 구분합니다.
기존 계획을 자동 재실행하지 않으며, 되돌리기도 새로운 수정안의 검토·권한·CAS
검사를 거칩니다. SDK 예제는 실제 자식 프로세스 종료를 검증하며 전원 장애나
DDS 제품 에디터 통합의 검증을 의미하지 않습니다.
