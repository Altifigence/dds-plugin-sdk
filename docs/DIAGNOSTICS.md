# Local diagnostics and debugging

Import `createDiagnosticSession`, `profileHost`, `profileTransport` and
`parseDiagnosticReport` from `@altifigence/dds-plugin-sdk/diagnostics`.
Sessions are disabled by default. They do not transmit reports or inspect plugin
arguments, response bodies, filenames, URLs, stack traces or arbitrary errors.

```js
const diagnostics = createDiagnosticSession({enabled: true, sampleEvery: 1});
const host = profileHost(createPluginHost({jobs: true}), diagnostics);
// Activate and exercise your explicitly trusted plugin.
host.dispose();
const report = diagnostics.snapshot();
diagnostics.dispose();
```

`profileHost` is an explicit adapter: it keeps the original signatures and
results, measures activation, commands, language calls, job admission, binary
reads and disposal, and records the SDK-owned resource counts. Job admission
duration is not whole-job duration. Wrap the wait for completion in
`diagnostics.measure('job', callback)` when that is the quantity you need.
`profileTransport(fetch, diagnostics)` measures the caller's transport operation
without consuming/duplicating a request or response body. Fetch duration ends at
response headers, not at completed streaming download.

## Correlation and measurements

For nested stages, retain a live parent span explicitly:

```js
const command = diagnostics.begin('command', {inputBytes: 64, queueDepth: 2});
const transport = diagnostics.begin('transport', {
  ...(command.id ? {parentId: command.id} : {}), inputBytes: 64,
});
// Perform the operation yourself; no input is passed to the recorder.
transport.end({outputBytes: 128, resources: {memoryBytes: 1024}});
command.end({outputBytes: 128});
```

Only fixed operation/resource names and bounded numeric metrics are accepted.
IDs are generated locally. Parent IDs must identify a currently retained span.
Durations are milliseconds from a monotonic local `performance.now()` clock
(or the caller's `now` function). `startedAt` is local clock time, not a UTC
timestamp. Backwards clock readings are clamped. Byte counts, queue depth and
memory estimates in manual spans are supplied by the owner; absent measurements
remain `null`, not zero. Retained byte counts divided by measured duration can
describe throughput for that selected operation; they are not network telemetry.

Errors retain a fixed SDK error code and status, with unknown errors mapped to
`provider_failed`. The original error still reaches the caller. Diagnostic
failures in `measure`, `profileHost` or `profileTransport` do not change the
underlying operation's result. Validate manually supplied metadata with `begin`
and `end` when you need explicit validation errors.

The report is schema version 1, also available as `diagnostic-report.schema.json`.
Limits are 256 retained events, 64 active spans, 256 KiB export, sampling every
1–1,000 attempts and 1–300,000 ms retention. Default capacity is 128 and retention
60 seconds. Expiry is lazy on recording/readback: the profiler owns no background
timer. Full buffers discard oldest events; expired/untracked active spans count
as dropped. Sampling is deterministic by attempt number. Totals describe the
session, while retained events describe its sampled/retained subset. `clear()`
clears completed events; `dispose()` stops recording and releases active spans.

`host.inspect()` is allowed after disposal. Pending activations, normal/provider
operations, jobs and checkpoints stay visible until the actual work settles,
including a provider that ignores cancellation. Other fields count registrations,
commands, retained jobs, language caches and SDK timers. Arbitrary process memory,
global timers and escaped child processes are outside this inspection. A host
retains no authority to stop an in-process infinite loop.

## CLI profile and debugger

```sh
npx --no-install dds-plugin dev . --trust-local-code --command greet --input '{"name":"Ada"}' --profile
npx --no-install dds-plugin dev . --trust-local-code --debug --debug-wait --timeout-ms 30000
```

`--profile` emits one bounded `profile` event at ordinary child completion.
Crashes, forced timeouts and kills may have no final profile. Trusted plugin
stdout/stderr remain their normal, unredacted streams and are separately limited
to 256 KiB; review them before sharing. The metadata report itself excludes their
bodies. No source code, heap snapshot or CPU profile is collected automatically.

`--debug` explicitly opens the current development child on a fresh ephemeral
`127.0.0.1` inspector port. There is no host/address option. The `debug` event
contains its WebSocket URL and remaining lifetime. `--debug-wait` waits before
plugin import until the debugger sends `Runtime.runIfWaitingForDebugger`.
Each debug child has a hard deadline of at most 30 seconds, including waiting or
paused execution. Watch restarts receive a new child/endpoint under the same
explicit command invocation. Completion, cancellation, deadline and crash use the
existing owner-only process-tree cleanup. Debugger connections end with that child.

The inspector executes code with the child's authority. Only use these flags for
trusted local code. The SDK does not isolate code, grant product access, clean
escaped processes, or undo prior effects. Node documents the inspector's
[open/wait/close behavior](https://nodejs.org/docs/latest-v22.x/api/inspector.html#inspectoropenport-host-wait).

`npm run benchmark:devtools` measures five batches of 10,000 tiny synchronous
operations with no instrumentation, disabled recording, every-tenth sampling and
all-event recording, then checks 100 scenario lifecycles. It reports actual local
overhead; it imposes no universal timing threshold. See [performance](performance.md).

## 한국어

진단은 명시적으로 켠 로컬 세션에서 고정 지표와 SDK 소유 자원 수만 수집합니다.
입력·응답 본문·경로·임의 오류 메시지는 보고서에 넣지 않습니다. stdout/stderr는
별도 원문 출력이므로 공유 전에 확인하세요. 취소를 무시한 작업은 실제 종료까지
계수에 남습니다. `--debug --debug-wait`는 신뢰한 자식 프로세스의 loopback 임시
포트만 열며 대기·일시정지를 포함해 최대 30초 후 정리합니다. OS 격리는 제공하지 않습니다.
