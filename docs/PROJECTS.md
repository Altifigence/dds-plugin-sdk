# Workspace projects and edit sessions

SDK 0.3.0 adds helpers over the existing workspace protocol v1, including servers
using SDK 0.2.x. They introduce no remote method or extra permission. Run
`npm run example:project` for a complete local HTTP example that creates and
removes only its own temporary directory.

```js
import {createWorkspaceClient, createWorkspaceProject} from '@altifigence/dds-plugin-sdk/workspace-client';

const client = createWorkspaceClient({url, token});
await client.connect();
// Review the workspace identity, notice, capabilities and grants in your host UI.
const project = createWorkspaceProject(client);
const file = await project.openFile('rtl/top.sv');
try {
  await file.saveEdits([{
    range: {start: {line: 0, character: 0}, end: {line: 0, character: 0}},
    text: '// Reviewed change\n',
  }]);
  console.log(file.snapshot.revision);
} finally {
  project.dispose();
  client.dispose();
}
```

The host owns `url`, `token`, connection review and user authorization. The SDK
does not create a consent dialog or grant access automatically.

| API | Behavior |
| --- | --- |
| `project.workspace` | Bound workspace ID, name and generation |
| `project.listFiles(path?, options?)` | One directory listing under the selected root |
| `project.openFile(path, options?)` | Read a file and retain its immutable content/revision in a session |
| `project.createFile(path, content, options?)` | Create-if-absent using revision `null`, then return a session |
| `project.watchFiles(paths, options?)` | Observe 1–16 explicit file revisions without changing edit snapshots; SDK 0.5.0 |
| `session.snapshot` | Last confirmed `{path, content, revision}`; not editable |
| `session.save(content, options?)` | Save against the retained revision; never force overwrite |
| `session.saveEdits(edits, options?)` | Apply edits against one snapshot, then perform one CAS save |
| `session.reload(options?)` | Explicitly read the latest content/revision |
| `session.state` | `ready`, `saving`, `reloading`, `needs-reload` or `disposed` |
| `dispose()` | Cancel owned work; project disposal leaves the caller's client connected |

Read/write options are `{signal?, timeoutMs?}`. Observation has separate
[options and lifetime rules](OBSERVATION.md). Only one save/reload may run per session.
Two sessions editing the same file retain independent revisions. A conflict or
failed write moves the session to `needs-reload`; further saves fail until an
explicit `reload()` succeeds. Preserve any unsaved UI draft separately and let
the user reconcile it with the fresh content. The library never merges or retries
automatically. A timeout/cancel/lost response may occur **after** the server
committed a write, so cancellation is not proof of rollback.

Projects capture the exact client binding. Disconnect, authentication/generation
failure or any reconnect invalidates old projects and sessions, even if the
same workspace UUID/generation is returned. Create a new project only after the
host has reviewed the new connection. Disposal is idempotent; late results cannot
update a disposed session.

`applyTextEdits(content, edits)` is a pure helper. Each edit has `{range, text}`.
All positions refer to the original content, with zero-based lines and UTF-16
offsets. CRLF/LF/CR are preserved outside replaced ranges. Overlapping edits,
ambiguous insertions at the same offset, out-of-bounds/reversed ranges, split
surrogate pairs and malformed Unicode are rejected before writing. There are
at most 500 edits and 64 open or opening sessions per project. Text and resulting
files remain limited to 262,144 UTF-8 bytes; JSON and request limits also apply.

These helpers inherit server restrictions: selected root, protected paths,
read-only mode and per-file revision checks. File observation samples existing
reads; it does not add OS filesystem watching, recursive discovery,
multi-file transactions, shell access or cross-process
atomicity against an external editor. See [workspace limits](WORKSPACES.md).

## 한국어

프로젝트는 명시적으로 연결한 client의 한 연결에 묶입니다. `openFile()`은 파일을
읽어 내용과 revision을 보관하고, `save()`와 `saveEdits()`는 그 revision이 유지될
때만 저장합니다. 충돌·취소·응답 유실 뒤에는 `needs-reload` 상태가 되며 명시적
`reload()` 전까지 다시 저장할 수 없습니다. UI의 미저장 초안은 따로 보존하고
새로 읽은 파일과 비교해 사용자가 결정하도록 하세요.

재연결하면 같은 workspace ID여도 기존 프로젝트·편집 세션을 재사용할 수 없습니다.
취소는 이미 서버에 저장된 변경을 되돌리지 않습니다. 텍스트 편집은 같은 원본을
기준으로 적용하고 겹친 범위·잘못된 Unicode·제한 초과를 거부합니다. 0.2.x 서버와
같은 HTTP protocol v1을 사용하며 새 실행 권한이나 DDS 제품 설치 기능은 추가하지 않습니다.

0.5.0의 `watchFiles()`는 지정한 파일의 revision 변경만 알립니다. 기존 snapshot을
자동으로 갱신하지 않으며 관찰 중단·프로젝트 폐기 시 관련 읽기 요청을 취소합니다.
상세 제한과 예제는 [변경 관찰 안내](OBSERVATION.md)를 확인하세요.
