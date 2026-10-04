# Job history and explicit retry (0.8 development)

History is an opt-in extension over [job storage](JOB_STORAGE.md). It does not
alter v1 hello, job states or existing live `getJob()` replies. New clients report
storage disabled on known 0.7 and earlier hosts without sending unknown methods.
An explicit `unsupported` discovery response also disables it; malformed replies,
authentication failures and transport errors are not downgraded.

## Enable the Node server

```js
import {createNodeJobStore} from '@altifigence/dds-plugin-sdk/job-storage-node';
import {createWorkspaceServer} from '@altifigence/dds-plugin-sdk/workspace-node';
import {createWorkspaceClient} from '@altifigence/dds-plugin-sdk/workspace-client';

const store = await createNodeJobStore({directory, workspaceRoot: root, workspaceId});
const server = await createWorkspaceServer({
  root, workspaceId, token, notice,
  plugins: [{plugin, artifactSha256: verifiedPackageSha256}],
  grants: ['workspace.read'], jobs: true, jobStorage: {store},
});
const client = createWorkspaceClient({url: server.url, token});
await client.connect();
const capabilities = await client.getJobStorageCapabilities();
const query = {limit: 16, commandId: 'analyze'};
const page = await client.listJobHistory(plugin.manifest.id, verifiedPackageSha256, query);
if (page.nextCursor) {
  const next = await client.listJobHistory(plugin.manifest.id, verifiedPackageSha256,
    {...query, cursor: page.nextCursor});
}
const prior = await client.recoverJob(plugin.manifest.id, previousJobId, verifiedPackageSha256);
const attempt = await client.retryCommandJob(plugin.manifest.id, previousJobId,
  reviewedFreshInput, verifiedPackageSha256, {jobId: crypto.randomUUID()});
client.dispose();
await server.close(); // flushes cancellation checkpoints, not arbitrary provider completion
await store.close(); // the operator owns this store
```

The operator supplies reviewed plugin code, the verified package digest, notice,
token, absolute root/storage paths and a stable workspace ID. Storage uses a
server-owned Node workspace and host; the server binds the real root identity and
configured plugin hashes. Custom workspace/host ports can use the core host's
`jobStorage` option directly. No storage path is accepted from a remote request.

## Queries and pagination

`listJobHistory(pluginId, hash, query, requestOptions)` returns committed metadata
for that plugin, current hash, workspace and command registration. Every recorded
grant must still be granted; unauthorized or unavailable commands are omitted.
An inactive plugin or missing current read grant denies the entire request.

Filters are `state` (the original v1 state), `disposition` (`live`, `completed`,
`interrupted`, `expired`), `commandId`, inclusive start times `from`/`to` and
`attemptOf`. Default page size is 16, maximum 32, scanning at most the store's
256 records. There is no free-form input/log search or raw-input retention.

The first page freezes membership, order and displayed metadata, sorted by
descending `startedAt` then ascending job ID. Pages carry `asOf`, `expiresAt`
and an opaque cursor. Reuse the same filters and limit with that cursor. The host
keeps at most eight paginated snapshots for 60 seconds; exhausted slots fail
with `budget_exceeded`. New jobs are excluded from existing snapshots. Removed
records and revoked access are skipped on later pages; current expiry is shown
as `expired`. This can shorten a page, and expired entries can differ from the
initial disposition filter. Restarts lose cursors; stale/changed-filter cursors
return `conflict`. Restart a query to refresh state or obtain a new snapshot.

Items expose identifiers, timestamps, v1 state, recovery disposition, record
revision, parent attempt ID, content policy and artifact count. `resultAvailability`
is `none`, `source-references` or `expired`: this stage does not retain file bytes
and cannot prove that a referenced source still exists. Corrupt/unsupported
entries are omitted from lists because their ownership cannot be accepted;
explicit recovery by known ID returns the bounded error disposition.

## Explicit retry and duplicate requests

`retryCommandJob(pluginId, previousJobId, input, hash, jobOptions, requestOptions)`
requires a retained completed/interrupted parent, a fresh ID and explicit input.
It rechecks the current command definition and input parameters, package digest,
workspace and grants. Secrets must be supplied again by the caller through the
operator's current approved mechanism. Inputs and secrets are not restored from
history. Retry never widens permissions or runs a tool the host has not enabled.

The new record stores `attemptOf`; the parent remains unchanged. Retry returns
a `JobRecovery` with the current response scope and original persisted snapshot
scope. It acknowledges a checkpoint, not necessarily completion. Repeat the
same new ID, parent, validated input and timeout to obtain the retained attempt
without executing again, including after restart. Different values conflict.
An interrupted repeated attempt stays interrupted; use another fresh ID to run
again deliberately. Removed/expired parents or attempts cannot supply this
idempotency guarantee. Always generate fresh IDs for new executions.

Caller cancellation stops waiting; it does not prove that accepted work was
undone. Reconnect and query the chosen new job ID before deciding to retry.
`getJob()` and observers still cover live jobs in the current host; use recovery
for earlier generations. Tokens and consent are never restored from the store.

Core equivalents are `host.listJobHistory(pluginId, query)` and
`host.retryCommandJob(pluginId, previousJobId, input, jobOptions)`. The HTTP
methods are `history.capabilities`, `history.list`, `history.recover` and
`history.retry`; each uses the existing authenticated generation-bound envelope.
See the [real-process example](../examples/durable-jobs/run.mjs), types and
`job-history-query` / `job-history-page` schemas for executable contracts.

## 한국어

저장된 작업은 현재 workspace·플러그인 해시·명령·권한으로 다시 조회합니다. 상태,
명령, 시작 시간, 이전 실행 ID로 필터링하며 페이지 순서는 첫 조회 때 고정됩니다.
추가 작업은 기존 페이지에 들어오지 않고, 삭제·권한 철회는 다음 페이지에서 제외되며
만료는 명시됩니다. 최대 32개씩 조회하고 페이지 유효 시간은 60초입니다.

재실행은 현재 스키마로 검증한 새 입력과 새 작업 ID가 필요합니다. 새 기록의
`attemptOf`가 원래 작업을 가리키고, 원래 상태·결과는 유지됩니다. 같은 재실행 ID와
입력을 반복해도 새 실행을 만들지 않습니다. 재시작으로 중단된 시도는 자동 재개하지
않습니다. 토큰·비밀 입력·과거 동의를 복원하지 않으며, 취소 후에는 선택한 ID를
조회해 실행 여부를 확인해야 합니다.
