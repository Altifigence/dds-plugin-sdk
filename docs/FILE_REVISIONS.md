# File revisions and conditional reads

SDK 0.6.0 reduces response traffic for file observation. A connected client
provides three methods, with frozen results and the usual `signal` and
`timeoutMs` request options:

| Client method | Result |
| --- | --- |
| `getFileCapabilities(options?)` | `{protocolVersion:1, revision:boolean, conditionalRead:boolean}` |
| `getFileRevision(path, options?)` | `{path, revision}` with no file content |
| `readFileIfChanged(path, knownRevision, options?)` | `{path, revision, notModified:true}` or `{path, revision, notModified:false, content}` |

`knownRevision` is an exact lowercase SHA-256 from a previous read, or `null`
to request current content. A missing file rejects with `not_found` even when
the previous revision is supplied. An unchanged reply has **no content field**;
an empty changed file instead has `content: ''` and `notModified: false`.

```js
let cached = await client.readFile('design.sv'); // A connected, authorized client.
const current = await client.readFileIfChanged(cached.path, cached.revision);
if (!current.notModified) cached = current;
console.log(cached.content);

const metadata = await client.getFileRevision('design.sv');
console.log(metadata.revision);
```

Keep any unsaved editor draft separate from this cache. These methods do not
update a project edit session or change its expected save revision. A revision
sample is not a lock: another process may edit the file immediately afterward.
Use the revision belonging to the returned content when later saving. The
conditional operation reads and hashes one file snapshot, avoiding a separate
metadata-then-content round trip with mismatched snapshots.

## Discovery and old servers

The optional wire methods are `fs.capabilities`, `fs.revision` and
`fs.readIfChanged`. Their definitions do not change the strict v1 `hello`,
`fs.read`, permission, manifest or job contracts. Existing clients can keep
using their original methods on a 0.6 host.

The client caches file capabilities for its current connection and clears the
cache on disconnect, reconnect, disposal or authentication/identity revocation.
Known SDK hosts (`hostId: 'workspace-host'`, versions 0.0–0.5) use existing
`fs.read` without probing: those parsers reject new methods before preserving
the request ID. Other hosts must answer `fs.capabilities` or return a correctly
correlated `unsupported` error. Each advertised false capability independently
selects the bounded full-read fallback. Fallback keeps the same result shape,
but transfers the whole content before discarding it for unchanged results.

An invalid or mismatched reply, authentication/permission failure, timeout or
transport error is never treated as lack of support. If an advertised file
method later returns `unsupported`, the operation fails directly; it does not
retry or downgrade. Capabilities remain scoped to the current binding. A
reconnection during discovery cancels the old operation rather than letting it
read the replacement workspace. `timeoutMs` applies to each HTTP request;
first use may perform discovery and a file request. A caller signal covers both.

## Observation, bounds and measurement

`project.watchFiles()` automatically uses `getFileRevision()`. On 0.6 hosts,
initial and subsequent samples transfer only the revision; events, polling
intervals, observer capacity, cancellation and draft preservation are unchanged.
On old hosts, the helper falls back to the previous bounded file read.

The server still reads and SHA-256 hashes the file for every sample. This change
reduces **network response bytes**, not disk reads or hashing cost. No mtime or
size-only shortcut replaces content identity. The same UTF-8 validation,
262,144-byte limit, protected path policy and hardlink/symlink guards apply.
Custom workspace ports remain responsible for their own file isolation.

From a repository checkout, run `npm run benchmark:files`. It compares 20
unchanged samples of a 200,000-byte file across full reads, revision reads and
conditional reads. The measurement counts JSON request and response bodies,
including one discovery response per optimized mode. It excludes HTTP headers,
TLS and the initial hello/content baseline. Timing is local and indicative.

In the Node 22.23.1 Windows run on 2026-10-04, full reads returned 4,003,974
bytes, revision reads 3,867 bytes (99.903% less), and unchanged conditional
reads 4,247 bytes (99.894% less). This fixture measures traffic, not a latency
or filesystem performance guarantee.

## 한국어

0.6.0의 `getFileRevision()`은 본문 없이 파일 리비전만 반환합니다.
`readFileIfChanged(path, knownRevision)`은 리비전이 같으면 `notModified: true`만
반환하고, 바뀌었으면 `notModified: false`와 현재 본문을 반환합니다. 처음 읽을
때는 `knownRevision: null`을 사용합니다. 삭제된 파일은 `not_found` 오류입니다.

파일 감시는 새 서버에서 이 리비전 조회를 자동 사용합니다. 알려진 0.5 이하 SDK
서버는 기존 읽기로 전환하고, 다른 서버는 기능 조회 또는 요청 ID가 일치하는
`unsupported` 응답을 제공해야 합니다. 권한·인증·시간제한·네트워크 오류나 잘못된
응답은 숨기지 않습니다. 재연결하면 기능 캐시를 지우고 다시 확인합니다.

절감 대상은 네트워크 응답량입니다. 서버의 안전한 전체 파일 읽기·해시 계산,
UTF-8·크기·보호 경로·링크 검사는 유지합니다. 감지 결과는 편집 초안이나 저장
리비전을 자동 변경하지 않습니다. SDK 기능과 DDS 제품 배포는 별도로 검증합니다.
