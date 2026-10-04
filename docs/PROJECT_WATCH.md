# Project observation (SDK 0.9.0)

This optional Node port is available in SDK 0.9.0, with
[HTTP/client integration](PROJECT_TOOLS.md). It does not change the existing explicit-file `watchFiles()` API or grant a plugin
access to a wider workspace. DDS product UI integration is a separate consumer.

```js
import {createNodeWorkspace} from '@altifigence/dds-plugin-sdk/workspace-node';
import {createNodeProjectWatcher} from '@altifigence/dds-plugin-sdk/project-watch-node';

const workspace = await createNodeWorkspace({root: operatorChosenAbsoluteRoot});
const watcher = await createNodeProjectWatcher({
  workspace, roots: ['rtl'], fileSystem: 'local',
});
try {
  for await (const event of watcher.watch({
    root: 'rtl', include: ['**/*.sv'], exclude: ['generated/**'],
  }, {signal: controller.signal})) {
    console.log(event.kind, event.cursor, event.snapshot.complete, event.reason);
  }
} finally {
  watcher.dispose();
  workspace.dispose();
}
```

`roots` is an explicit operator allowlist. Each request names a root inside that
list. An empty string allows the workspace root only when the operator includes
it. Exclusions prune directories. Includes select returned paths, while necessary
parent directories may be traversed inside the allowed root. Patterns are
case-sensitive and support `*`, `?`, and a complete `**` path segment; they are
not regular expressions. `**/*.sv` also matches a file directly under the root.
Private workspace components, staging files, symbolic links, junctions and
hardlinked files are excluded by the existing workspace policy. Unsafe entries
make the view explicitly incomplete without exposing the excluded path.

## Snapshots and change semantics

`snapshot(options)` returns a bounded, sorted view. Every fully hashed file has a
SHA-256 `revision`; directories and files skipped by a byte limit have `null`.
The `fingerprint` of an unverified file is opaque metadata, not a checksum.
`complete: false` and `reasons` describe scan truncation, oversized files,
unstable entries and other limits. Never interpret an incomplete view as proof
that an absent file was deleted. The snapshot revision identifies the returned
view, not an atomic transaction over the filesystem. Each file is validated
before and after reading, and may still change after it was observed.

The first watch event is `snapshot`, or `resync` when the initial scan overlaps
native hints or is incomplete. Directory watchers are attached before traversal.
Events during that boundary trigger another reconciliation. Later events contain
created/changed/deleted entries and the new view. A rename is always delete/create;
the port does not invent an exact move relationship from OS hints. Directory and
case-only renames follow the same rule. Rapid changes may coalesce into one final
observed state, including a create/delete that has no surviving entry.

Every subscription has a fresh UUID and increasing cursor. A cursor is not a
durable filesystem journal or a promise to capture every intermediate write.
Consumers apply changes only against `previousRevision`; after any mismatch or
`resync`, replace the bounded view and honor its completeness flags. Do not
overwrite editor drafts or their CAS revision when a watch event arrives.

Native hints use a 50 ms default debounce. A full bounded reconciliation also
runs every second by default, including when native callbacks are unavailable.
Missing filenames, more than 1,024 hints before a scan, OS watcher errors and
watcher capacity limits produce explicit resync reasons. A scan overlapping
hints also requests resync. No correctness claim depends on OS event ordering.

## Resource and lifecycle bounds

The port permits four observers and 128 native directory handles in total. It
serializes scans with an eight-operation queue. Each observer retains at most
four events; a slow consumer receives `consumer_overflow` and a fresh view after
older queued events are discarded. There is one pending `next()` per observer.
An event with more than 256 changes becomes `change_limit` resync instead.

Defaults are 512 entries, depth 8, 1 MiB per file and 16 MiB read per scan. Hard
limits are 1,000 entries, depth 32, 16 MiB per file, 64 MiB per scan, 10,000 visited
directory entries and 128 KiB per snapshot. Scans default to a 10-second budget,
up to 30 seconds. Time and cancellation are checked between filesystem calls;
they cannot interrupt a blocked kernel filesystem operation. Byte budgets do
not include OS directory/stat metadata reads. No file content is retained in an
event. `inspect()` reports observers, handles, queued events, scans, bytes hashed
and scan durations without exposing absolute paths.

Breaking a `for await` loop or calling `return()` closes that observer and awaits
its active scan. Abort, `revoke()`, workspace disposal and port disposal close
native handles and discard late events. Revocation is terminal: create a new
explicitly authorized port to observe again. Removing or replacing the selected
root ends the observer with an error; the caller must review and resubscribe.
These guards are not an OS sandbox against a process that controls the host.

## Platform scope and verification

The supported profile is explicitly selected local filesystems on Windows and
Linux with supported Node 22/24. The test/benchmark output records the actual
platform and numeric filesystem type. Network filesystems and unqualified
virtual/mounted filesystems are unsupported; callers must not label them local
to imply tested native-event behavior. `fileSystem: 'network'` and other platform
profiles fail with `unsupported`. `capabilities` states the declared profile,
detected filesystem type, limits and delete/create rename semantics; it does not
certify a mount. Native failures remain visible and polling remains bounded.

See the [Node filesystem caveats](https://nodejs.org/docs/latest-v22.x/api/fs.html#caveats).
The SDK tests actual atomic replacement, repeated writes, new directories,
renames, deletion, junction insertion, cancellation, revocation and bounded slow
consumers. Deterministic native callback fixtures cover the initial scan race,
unknown filenames, overflow and native API failure. Run:

```sh
npm run example:project-watch
npm run benchmark:project-watch
```

한국어: 이 선택적 포트는 운영자가 허용한 상대 폴더만 감시합니다. OS 이벤트는
힌트로 사용하고 제한된 파일 읽기와 SHA-256으로 실제 상태를 확인합니다. 누락·
버퍼 초과·부분 결과는 재동기화/불완전 상태로 표시하며, 이동은 삭제와 생성으로
표현합니다. 중지·권한 철회 시 관찰 자원을 해제합니다. 네트워크 파일시스템과
제품 UI 통합은 이 지원 범위에 포함되지 않습니다.
