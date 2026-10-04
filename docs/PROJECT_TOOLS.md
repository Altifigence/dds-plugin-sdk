# HTTP project tools (SDK 0.9.0)

Enable these tools for explicit operator-selected directories on a local Windows
or Linux filesystem. [Node observation](PROJECT_WATCH.md) and
[tree/search](PROJECT_QUERIES.md) remain available independently.

```js
const server = await createWorkspaceServer({
  root:operatorWorkspace,workspaceId,token,notice,
  projects:{roots:['rtl'],fileSystem:'local'},
});
const client = createWorkspaceClient({url:server.url,token});
await client.connect();
const project = createWorkspaceProject(client);
if (!(await project.getProjectCapabilities()).enabled) {
  throw new Error('Project tools are unavailable');
}
const query = {root:'rtl',query:'module ',pageSize:16};
let page = await project.searchText(query);
for await (const event of project.watchProject({root:'rtl'},{signal})) {
  if (event.snapshot.revision !== page.snapshotRevision) {
    if (page.nextCursor) await project.releaseProjectQuery(page.nextCursor);
    page = await project.searchText(query); // same explicit scope, new membership
  }
  renderExternalView(event,page); // preserve caller drafts and edit snapshots
}
project.dispose();client.dispose();await server.close();
```

`getProjectSnapshot`, `listTree`, `searchFiles`, `searchText`, `releaseProjectQuery`
and `watchProject` are available on both the HTTP client and its project helper.
The helper binds them to the original connection and aborts them on disposal.
Edit sessions retain their snapshot and CAS revision until an explicit successful
save or reload. A file may move or disappear while a draft is open; the caller
decides how to resolve it instead of replacing the draft automatically.

## Discovery, scope and validation

The original v1 hello shape is unchanged. `projects.capabilities` returns the
workspace/generation scope, enabled status, Node watch/query capabilities, allowed
roots and transport limits. The server option is disabled by default and requires
a server-owned Node workspace. Cached capabilities describe a connection, not an
enduring grant: each operation checks current project authority and paths.
`server.revokeProjects()` terminates subscriptions, drops query views and denies
further project operations. Re-enabling requires a new server generation.

Known SDK 0.3–0.8 hosts report disabled without a discovery probe, because they
reject unknown envelopes before retaining a request ID. Other hosts may return
an explicit `unsupported` discovery response. Malformed results, authentication,
generation, permission and transport errors do not trigger fallback. New project
methods return `unsupported` when disabled. The host can separately choose the
existing explicit-file `watchFiles()` API; no entire-workspace listing is automatic.

Requests retain the bearer token, allowed-origin policy, workspace ID, generation,
body/concurrency limits and cancellation mechanism. Results carry their current
workspace/generation scope. The client checks it against the captured connection,
and checks the selected root, patterns, depth, limits, snapshot SHA-256, query
identity, pagination positions, filename/text matches and watch continuity.
Snapshot hashes cover canonical `{root,entries,reasons}` JSON. These are per-file
validated views, not filesystem-wide transactions; files can change afterward.

## Subscription lifecycle and recovery

`watchProject` is a pull-driven async iterator. The first `next()` starts a remote
subscription and returns a full initial view. Later reads have at most one request
in flight, with a maximum one-second server wait. No-change polls yield no event.
Concurrent `next()` calls return `conflict`. Breaking a `for await` loop or calling
`return()` stops the remote subscription and releases its native resources.

The transport permits four subscriptions per server and four per client. Each
native subscription retains four pending events; overflow collapses them into a
full `consumer_overflow` resync view. Debounce may coalesce writes; uncertain
renames remain delete/create. Cursor gaps or inconsistent predecessor/delta data
yield a full client resync with `cursor_gap` or `revision_mismatch`. A changed native
subscription ID, wrong scope, malformed view or invalid snapshot hash is rejected.

An idle subscription expires after 30 seconds by default. The operator can set
`projects.leaseMs` between 250 and 30000 milliseconds. Active polls finish before
the idle lease restarts. Slow consumers make no background requests between reads.
After a pause past the lease, the next read returns `not_found`; create a new
iterator for a fresh snapshot. Raw transport clients can repeat an older cursor
to get the latest delivered event, treating any gap as resync. Cursors ahead of
the host are invalid. Watch cursors and paged query cursors are separate contracts.

Abort, project disposal, disconnect, authentication/generation changes and server
shutdown discard late replies. Explicit cleanup sends a bounded best-effort stop;
a lost connection may leave resources alive until the idle lease expires. Cancelling
an in-flight poll also ends its subscription. An uncooperative custom fetch cannot
make iterator cleanup wait indefinitely. After reconnecting, create a new project
helper and iterator. The SDK does not reconnect automatically or reconstruct all
intermediate writes. Requery the original selected scope to remove stale tree/
search entries while retaining the draft separately.

`watchProject(options,{signal,requestTimeoutMs,timeoutMs})` accepts a per-request
timeout up to 30 seconds and an optional overall timeout up to 30 minutes. There is
no default overall timeout. Existing client/server request timeouts default to
five seconds; raise them deliberately for a larger bounded scan. Query cursors
retain their own 60-second maximum lifetime, eight-view limit and explicit release.

## Examples

`npm run example:project-tools` creates a disposable project, searches a new file,
observes an external write, refreshes the same query, keeps a draft, rejects a
stale CAS save, reloads explicitly and reconnects. CI runs it from a real installed
archive alongside Node watcher/query examples on Windows/Linux and Node 22/24.

`npm run example:project-browser` starts a loopback-only temporary workspace and
prints a local URL. Open it and choose **Run scenario** for the browser client flow.
Ctrl+C closes its servers and removes only its disposable workspace. A local
fixture token is generated; no account or DDS product workspace is involved.

## 한국어

SDK 0.9.0의 HTTP/project helper는 운영자가 지정한 root의 트리·검색·감시를
연결합니다. 기존 hello와 파일/작업 API는 유지하며 0.8 이하 서버에는 새 조회를
보내지 않고 미지원으로 표시합니다. 이벤트는 편집 snapshot이나 미저장 초안을
덮어쓰지 않습니다. 외부 변경 뒤에는 같은 검색 범위를 다시 조회하고, 수정은
기존 CAS 저장과 명시적 reload로 처리합니다.

구독은 서버·클라이언트당 최대 4개이고 이벤트 큐는 구독당 최대 4개입니다.
손실·순서 불일치는 전체 snapshot이 담긴 resync로 표시합니다. 기본 30초 이상
읽지 않은 구독은 만료되며, 재연결이나 긴 일시정지 뒤에는 새 project/iterator로
처음부터 관찰합니다. 취소·반환·권한 철회 시 자원을 해제하고 이전 연결의 늦은
응답을 버립니다. 연결 단절로 종료 요청이 전달되지 않으면 유휴 만료가 남은
자원을 정리합니다. Node 예제와 로컬 브라우저 예제를 직접 실행할 수 있습니다.
