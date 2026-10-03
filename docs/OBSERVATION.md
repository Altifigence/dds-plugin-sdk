# Observe workspace files and command jobs

SDK 0.5.0 adds `project.watchFiles()`, `client.watchJob()` and
`client.waitForJob()`. These helpers use existing `fs.read`, `jobs.events` and
`jobs.get` requests. They add no protocol method, permission or automatic
connection. Use a connected `createWorkspaceClient()` from this SDK, after the
host has reviewed the workspace and obtained the user's authorization.

## Explicit file paths

```js
import {createWorkspaceProject} from '@altifigence/dds-plugin-sdk/workspace-client';

const project = createWorkspaceProject(client);
const edit = await project.openFile('design.sv');
const original = edit.snapshot;
try {
  for await (const change of project.watchFiles(['design.sv'], {
    intervalMs: 1000,
    signal: abortController.signal,
  })) {
    console.log(change.kind, change.path, change.previousRevision, change.revision);
    if (change.kind !== 'initial') break;
  }
  console.log(edit.snapshot === original); // true: the retained editing revision has not changed.
} finally {
  project.dispose();
}
```

The example assumes an already connected `client` and caller-owned
`abortController`. Keep the user's unsaved draft outside the session. A change
event does not reload the file, update `edit.snapshot`, merge content, or save
anything. A subsequent save still uses the retained revision and can conflict.
Only call `reload()` when the user chooses how to reconcile their draft.

Each immutable event contains `{kind, path, previousRevision, revision}`:

| Kind | Meaning |
| --- | --- |
| `initial` | First successful sample of that path, including a missing file |
| `created` | Previous sample was missing; the path now has a revision |
| `changed` | Existing file's revision differs from its previous sample |
| `deleted` | Previously present path now returns `not_found` |

A missing revision is `null`. `initial.previousRevision` is always `null`.
Set `includeInitial: false` to record the baseline without yielding it. Equal
revisions produce no event. Only a server `not_found` response represents a
missing file; permission, protected-path, size and transport errors terminate
observation with their `WorkspaceError` code.

Supply 1–16 unique relative file paths. Paths are copied and validated before
HTTP work. The observer reads one file at a time in the supplied order, waiting
`intervalMs` between full passes. It uses the existing bounded UTF-8 file read;
the response's content is discarded after comparing its revision, and events
carry no content. This is sampled observation, not an OS filesystem watcher:
intermediate changes may coalesce and a create/delete between samples can be
missed. It does not discover directories or follow a renamed path. The server's
protected-file policy and file-size limit still apply. Read-only servers work.

## Follow one existing job

Check `getJobCapabilities()` before explicitly starting a job. Save its returned
`jobId`; observation never starts or cancels a command.

```js
let after = savedCursor ?? 0;
for await (const update of client.watchJob(jobId, {after, intervalMs: 1000})) {
  if (update.dropped) console.log('Expired events:', update.dropped);
  for (const event of update.events) console.log(event.kind, event.data);
  console.log(update.snapshot.state, update.snapshot.progress);
  after = update.nextCursor; // Persist with the job ID and workspace identity after handling the page.
}
```

An update contains `{snapshot, events, after, nextCursor, dropped, hasMore}`.
Snapshots and events are frozen, validated copies. Each page has at most 64
events, with retained history limited to 256 events by the job host. `dropped`
reports expired events since `after`; it is not a transport error. Snapshots are
read after event pages and can therefore be newer than that page. `hasMore`
includes this newer snapshot sequence. The iterator drains those pages before
ending on `succeeded`, `failed`, `cancelled` or `timed_out`. Consumers must not
stop merely because an intermediate page's snapshot is terminal.

Cursor, workspace scope and job identity must remain consistent. Regressing
sequences, a changed command identity or a changed snapshot with no new event
sequence fail closed. An unchanged running job yields no duplicate updates.

If only completion is needed:

```js
const result = await client.waitForJob(jobId, {after, timeoutMs: 120000});
if (result.state === 'succeeded') console.log(result.result);
else console.log(result.state, result.error.code);
```

`waitForJob()` returns the terminal snapshot for all four terminal states. A
failed command does not throw from this helper; observation errors do. It drains
the same event pages, discarding their payloads, and does not read result files.
Use the existing `readJobArtifact()` explicitly for revision-checked artifacts.

After an explicit host-approved reconnect, verify the same workspace ID and
generation, then create a **new** observer using the same job ID and last handled
`nextCursor`. Reconnection invalidates the old observer even when the returned
identity is unchanged. Jobs and cursors are in-memory host state; they do not
survive host restart or expiry. A missing job, unsupported server or transport
failure is reported directly, with no automatic retry or resubmission.

## Lifetime and budgets

Both iterators start HTTP work on their first `next()`. No requests are fetched
in the background while the consumer holds a yielded value. There is no event
queue: at most one read may be pending per observer; a concurrent `next()` fails
with `conflict`. `for await` with `break`, or explicit `return()`, aborts pending
observation work, settles a pending `next()` as done and releases resources.

| Option or limit | Behavior |
| --- | --- |
| `intervalMs` | Integer 250–60,000 ms; default 1,000 ms; no delay while draining job pages |
| `requestTimeoutMs` | Integer 1–30,000 ms per HTTP request; defaults to the client's request deadline |
| `timeoutMs` | Total duration from first `next()`, including time paused by the consumer; at most 1,800,000 ms |
| File observation duration | No total deadline unless supplied |
| Job observation duration | Default total deadline of 1,800,000 ms |
| Active observers | At most 8 per client, shared across all projects and job observers |
| `signal` | Caller `AbortSignal`; abort terminates observation with `cancelled` |

Budgets are exported as `WORKSPACE_OBSERVATION_LIMITS` from `workspace-client`.
Unused iterators reserve no slot. A deadline releases its slot even while the
consumer is paused and reports `budget_exceeded` on the pending or next read.
Project disposal stops its file observers; disconnect, reconnect and client
disposal stop all associated observers. Late responses cannot yield events.
Authentication or workspace revocation retains its error cause and invalidates
the connection. Other observation errors also terminate that iterator.

Stopping observation does **not** cancel the server job or undo completed
writes. To stop a job, explicitly call `cancelJob()` through the host's normal
authorized action. Observation never broadens existing grants.

## Run the complete example

Run `npm run example:observe` from this SDK checkout. From an installed archive,
copy `examples/workspace-observation/run.mjs` into your project and run
`node run.mjs`. It creates and removes its own temporary workspace, observes an
external change, checks the retained edit conflict, reconnects and waits for
the same command without executing it again. Expected output:

```text
Workspace observation: file changes, retained draft and resumed job verified
```

0.5 clients can observe files on 0.3.2/0.4 hosts and jobs on an explicitly enabled
0.4 host. Existing clients still use their original methods on a 0.5 host. See
[compatibility](COMPATIBILITY.md), [project sessions](PROJECTS.md) and
[command jobs](JOBS.md). DDS UI and Cloud integration require their own releases.

## 한국어

0.5.0은 지정한 파일 1–16개의 revision을 읽는 `project.watchFiles()`와 기존 작업을
관찰하는 `client.watchJob()`·`client.waitForJob()`를 추가합니다. 파일 변경 알림은
편집 세션의 snapshot이나 미저장 초안을 바꾸지 않습니다. 샘플 사이의 변경은 합쳐질
수 있으며, 삭제는 서버가 `not_found`를 반환했을 때만 표시합니다.

작업 관찰은 커서로 이벤트를 이어받고 유실된 과거 이벤트 수를 `dropped`로 알립니다.
종료 상태를 먼저 보더라도 `hasMore`인 페이지는 끝까지 읽어야 합니다. `waitForJob()`은
성공·실패·취소·시간 초과의 최종 snapshot을 반환하므로 `state`를 확인하세요.

반복을 멈추거나 AbortSignal을 취소하면 관찰만 끝납니다. 서버 작업을 중지하려면
`cancelJob()`을 명시적으로 호출해야 합니다. 재연결 뒤에는 호스트가 같은 workspace
ID·generation을 확인하고 기존 job ID와 처리한 커서로 새 관찰자를 만드세요. 자동
재실행·자동 권한 부여·영구 작업 보관은 제공하지 않습니다. 클라이언트당 파일·작업
관찰자 합계는 8개이며, SDK 설치만으로 DDS 제품의 파일 감지 UI가 추가되지는 않습니다.
