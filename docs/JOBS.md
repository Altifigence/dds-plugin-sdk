# Long-running command jobs

SDK 0.5.0 also supplies [`watchJob()` and `waitForJob()`](OBSERVATION.md) over these
existing requests. They drain event pages, support caller cancellation and
explicit cursor resumption, and never start or cancel the underlying command.

SDK 0.4.0 provides bounded, in-memory jobs for trusted workspace commands. A job
reports progress, plain-text logs and revision-pinned UTF-8 workspace files. It
does not add shell execution, a task scheduler, persistent storage or a DDS UI.

## Enable and start a job

Set `jobs: true` on `createPluginHost` or `createWorkspaceServer`. It defaults to
false. On the HTTP server, jobs require its own internally constructed plugin
host so job scope matches the server's workspace ID and generation. A supplied
`pluginHost` can still serve existing commands; its HTTP job extension is disabled.

```js
const server = await createWorkspaceServer({
  root, workspaceId, token, notice,
  plugins: [{plugin, artifactSha256}],
  grants: ['workspace.read', 'workspace.write', 'backend.invoke'],
  backends: {analyze: operatorConfiguredBackend},
  jobs: true,
});

await client.connect();
const capabilities = await client.getJobCapabilities();
if (!capabilities.enabled) throw new Error('This host has not enabled jobs');
const jobId = crypto.randomUUID(); // Keep this ID before sending the request.
let job = await client.startCommandJob(
  plugin.manifest.id, 'analyze', {path: 'design.sv'}, artifactSha256,
  {jobId, timeoutMs: 300_000},
);
```

The existing HTTP request deadline remains at most 30 seconds. Starting a job
returns its ID and a snapshot; execution has its own deadline. Query capabilities
before use. Older servers reject the new methods with `invalid_request` or
`unsupported`; do not interpret that as permission to use another execution path.
The v1 `hello` shape is unchanged so older clients can still use existing methods.

## Report from a command

```js
context.registerCommand({id: 'analyze', title: 'Analyze'}, async (input, {signal, job}) => {
  if (!job) throw new Error('Run this command as a job');
  signal.throwIfAborted();
  job.reportProgress({completed: 0, total: 2, message: 'Reading input'});
  const source = await context.workspace.readFile(input.path, {signal});
  job.log('info', 'Input loaded');
  const result = await job.invokeBackend('analyze', {source: source.content});
  await context.workspace.writeFile('report.txt', JSON.stringify(result), {
    expectedRevision: null, signal,
  });
  await job.addArtifact({id: 'report', path: 'report.txt', label: 'Analysis report'});
  job.reportProgress({completed: 2, total: 2, message: 'Complete'});
  return {report: 'report'};
});
```

`job` is optional on the existing command handler options and present only for job
execution. Existing plugins keep working. `job.invokeBackend` uses only named
operator-provided backends, requires the existing intersected `backend.invoke`
grant, and passes `{signal, pluginId, scope, job}` to the backend. Await operations
and respect `signal`. Nested operations are counted and drained before success;
ignored promises cannot create unlimited concurrent backend work. Existing
`context.backends.invoke` keeps its ordinary short deadline. A fixed
`createProcessBackend` may be configured with a timeout up to 30 minutes; its
existing JSON input/output and process cleanup rules still apply. It does not
interpret stdout as progress events; report progress from the named adapter.

Progress has integer `completed` and positive integer `total`, with
`completed <= total`; it may restart a phase and is not forced to be monotonic.
Logs accept `debug`, `info`, `warning`, `error`. Messages are one line, at most
2,048 UTF-8 bytes, and must not contain secrets. Render them as text. They are
bounded developer output, not audit evidence.

## Poll, cancel and reconnect

```js
let after = 0;
for (;;) {
  const page = await client.getJobEvents(jobId, after);
  after = page.nextCursor;
  if (page.dropped) console.log(`${page.dropped} earlier events expired`);
  for (const event of page.events) console.log(event.kind, event.data);
  job = await client.getJob(jobId);
  if (job.state !== 'running' && !page.hasMore && after >= job.lastSequence) break;
  await new Promise(resolve => setTimeout(resolve, 250));
}
if (job.state === 'succeeded') {
  const file = await client.readJobArtifact(jobId, 'report');
  console.log(file.content);
}
// Stop explicitly, including after a transport failure:
await client.cancelJob(jobId);
```

States are `running`, `succeeded`, `failed`, `cancelled` and `timed_out`. Terminal
states are final; errors expose stable SDK codes without provider error messages.
Events have increasing sequence numbers; fetch at most 64 at a time and use
`nextCursor`. Evicted events are counted in `dropped`, so clients can visibly show
an incomplete history instead of presenting it as complete. A cursor ahead of
the job's latest event is rejected.

Disconnecting a client, aborting a polling request or losing the start response
does **not** cancel the job. Reconnect to the same host generation, use the saved
ID, and call `getJob` or `cancelJob`. A start with the same ID and equivalent JSON
input returns the existing snapshot while retained; different arguments produce
`conflict`. After expiry or restart this is no longer an idempotency guarantee.
The client checks job ID, workspace, generation, command identity, cursor and file
digest on replies. Server auth, allowed origins and plugin artifact pins remain
required. The token represents one workspace operator: holders share access to
its jobs, not separate tenant identities.

Cancel and timeout abort cooperative execution and discard late output. They do
not undo prior side effects. Uncooperative provider or nested backend promises
keep their execution slot until they actually settle. Plugin/command disposal or
host shutdown aborts jobs; restart loses all in-memory jobs. Local host code is
trusted and must use OS isolation for stronger enforcement.

## Result files and budgets

`addArtifact` reads through the granted workspace port and captures SHA-256 and
byte length. Paths use the same protected, relative file policy as workspace HTTP
access; private files, traversal, symlinks and hardlinks are rejected by the Node
workspace. It does not copy or expose arbitrary host files. `readJobArtifact`
requires the plugin to remain active and the same read grant, checks that the
current content still matches the captured hash, and returns `conflict` if it has
changed. The server does not retain file bytes. Only UTF-8 files up to 256 KiB are
supported; binary/large simulation traces require a separate authorized artifact
service. Already registered files remain readable after cancellation while the
job is retained; they can be partial output and are not proof of success.

| Limit | Value |
| --- | --- |
| Concurrent unsettled jobs per host | 4 |
| Retained job records | 32 |
| Nested in-flight operations per job | 32 |
| Runtime default / maximum | 5 / 30 minutes |
| Terminal retention once settled | 15 minutes from last event; cleaned on next access |
| Events per job | 256 and 64 KiB, whichever is reached first |
| Events per page | 64 |
| Artifacts per job | 16 |
| File content | 256 KiB UTF-8 |
| JSON snapshot including result/metadata | 256 KiB, existing JSON depth/node limits |

The complete example is [command-jobs/run.mjs](../examples/command-jobs/run.mjs).
JSON schemas and TypeScript declarations are available through `/schemas` and
`/jobs`. Existing manifest versions and permission names are unchanged.

## 한국어

0.4.0의 장시간 작업은 호스트에서 `jobs: true`로 명시적으로 켭니다. 작업을 보내기
전에 UUID를 저장하고, 시작 후 `getJob`, `getJobEvents`, `cancelJob`으로 상태·로그·취소를
처리하세요. 연결이 끊겨도 작업은 계속됩니다. 같은 호스트 세대에 다시 연결해 저장한
ID로 조회할 수 있지만, 재시작이나 보관 기간 만료 후에는 이 보장이 없습니다.

명령의 `job` 객체가 진행률·로그·백엔드 호출·결과 파일 등록을 제공합니다. 기존
파일 읽기·쓰기·백엔드 권한을 그대로 적용합니다. 결과 파일은 상대 경로와 해시로
고정되며 내용이 바뀌면 읽기를 거부합니다. UTF-8 256 KiB까지만 지원하고 큰 바이너리
파형 파일은 포함하지 않습니다. 취소·시간 초과는 이전 파일 변경을 되돌리지 않으며,
등록된 일부 결과는 성공 판정과 별개입니다. SDK 기능 추가가 DDS 제품 화면에 적용됐다는
뜻은 아닙니다.
