# Project tree and search

Available in SDK 0.9.0. This optional Node port reuses an operator-created
[project watcher](PROJECT_WATCH.md) and does not expand its root scope.
The [HTTP/project client](PROJECT_TOOLS.md) offers the same scoped query methods.

```js
import {createNodeProjectQueries} from '@altifigence/dds-plugin-sdk/project-query-node';

const queries = createNodeProjectQueries({watcher});
const tree = await queries.listTree({root:'rtl',maxDepth:4});
const files = await queries.searchFiles({
  root:'rtl',query:'**/*.sv',mode:'glob',caseSensitive:false,
  exclude:['generated/**'],
});
const options = {root:'rtl',query:'module ',pageSize:16};
let page = await queries.searchText(options,{signal});
const cursor = page.nextCursor;
if (cursor) page = await queries.searchText({...options,cursor},{signal});
if (cursor) queries.releaseCursor(cursor);
queries.dispose();
```

Run `npm run example:project-query`. The installed archive consumer executes the
same example against real files, alongside a project observer.

## Scope and matching

Every query requires an explicit workspace-relative `root`. It must be inside
one of the operator's allowed roots. `include` and `exclude` use the watcher's
small, case-sensitive glob language against paths relative to the selected root:
`*`, `?`, and whole-component `**`. Excluded directories are not traversed.
Protected paths and symlink/junction/hardlink restrictions are unchanged.

`listTree` returns matching files and directories. `searchFiles` searches only
files: literal substring matching is the default; `mode:'glob'` matches the full
relative path. Use `**/*.sv` for names at any depth. `searchText` accepts nonempty
single-line literal text, with non-overlapping matches and no regular expressions.
`caseSensitive:false` folds ASCII A-Z only. Unicode remains exact; locale-dependent
or expanding case folding is not supported. Pattern exclusions remain case-sensitive.

Text search reads and hashes each selected file once, up to 256 KiB per file.
NUL-containing files are classified as `binary`; invalid UTF-8 as `invalid_utf8`.
Both make the captured query incomplete. The initial UTF-8 BOM is removed during
decoding, matching `readFile`; SHA-256 still covers every original byte.
LF, CRLF and CR delimit lines. Ranges are zero-based UTF-16 positions in the
captured content. A bounded snippet carries its starting character and leading/
trailing truncation flags. The snippet contains the entire matched string and
never splits a surrogate pair. `entry.revision` identifies the complete original
file, not just its snippet. Existing `listFiles` and text-file limits do not change.

## Pages and concurrent edits

A query captures a bounded, path-sorted result list. Text matches additionally
sort by line and character. A continuation cursor is bound to the same query,
limits, page size, query port instance and an issued offset. It expires after
60 seconds (an operator can select a shorter lifetime). New files and matches
do not enter an existing view. Repeat a query without a cursor to refresh it.
`releaseCursor` drops a retained view explicitly. Unknown, released, expired or
other-instance cursors return `not_found`; changing the query or guessing an
unissued offset returns `invalid_request`.

Each later page rescans the same bounded scope. Captured entries, content hashes,
ranges and snippets stay unchanged; `state` is `current`, `changed`, `missing` or
`unverified`, with `currentRevision` where a file was fully revalidated. A partial
rescan cannot establish absence and uses `unverified`. `stale` says the rescan
differs or was unstable. `complete`, `truncated` and `reasons` describe the initial
captured query, so a complete historical query may have a stale page. Page size
pagination alone does not mean truncated results. All times are Unix milliseconds.

This is a per-file validated view, not an atomic filesystem transaction. A file
can change immediately after validation. Re-read and use the existing revision
compare-and-swap before editing. Search or watch events never overwrite drafts.

## Bounds and lifecycle

| Resource | Default / maximum |
| --- | --- |
| Page items | 32 / 64 |
| Captured matches or tree entries | 256 / 512 |
| Query text | 256 UTF-16 code units |
| Snippet | 512 UTF-16 code units |
| Response JSON | 64 KiB / 128 KiB; minimum configurable 16 KiB |
| Retained match data per view | 256 KiB, plus the bounded project snapshot |
| Retained views per query port | 8; at most 60 seconds |
| Concurrent queries per port | 2; watcher scan queue remains at most 8 |
| Search file content | 256 KiB, optionally lower |
| Tree/file-name hashing | Watcher's 1 MiB default / 16 MiB maximum per file |
| Total bytes read per request | Watcher's 16 MiB default / 64 MiB maximum |
| Depth, entries, visited names | Watcher's 8/32 depth, 512/1000 entries, 10000 names |
| Scan/search time | 10 seconds default / 30 seconds maximum, cooperative checks |

The query deadline includes time spent waiting for the shared scan queue. An
already running filesystem syscall cannot be interrupted portably; cancellation
and deadlines are checked around I/O and search work. No extra read is performed
for text search after hashing. A continuation rescan has its own byte/time budget.
Response size can shorten a page without losing the remaining captured items.
Result count/data limits and scanner limits produce explicit `reasons` with
`complete:false` and `truncated:true`. Empty results are not proof of absence
when incomplete. Too many active operations or retained views returns
`budget_exceeded`. Release unused cursors before starting more queries.

Abort signals cancel pending work; late results are discarded and file handles
close. Query revocation/disposal clears views and terminates its pending queries.
Disposing or revoking the parent watcher/workspace also closes the query port.
Disposing only the query port leaves the operator's watcher available. Capabilities
declare the methods, ASCII case behavior, UTF-16 range convention, scope and limits.
`npm run benchmark:project-query` measures a 128-file, 2 MiB synthetic query and
one revalidated page. It reports actual bytes read and released views; it does not
claim representative performance for every filesystem.

## 한국어 요약

운영자가 허용한 상대 경로 안에서 트리·파일명·본문을 검색합니다. 일반 문자열과
제한된 glob만 지원하며, 대소문자 무시 옵션은 ASCII A-Z에 적용합니다. 본문은
파일당 256 KiB 안에서 한 번 읽어 검색과 SHA-256을 함께 계산합니다. 결과에는
원본 리비전과 UTF-16 범위, 잘린 문맥 여부가 포함됩니다. 바이너리·잘못된 UTF-8·
읽기/시간/결과 한도로 검색하지 못한 부분은 명시적으로 표시됩니다.

다음 페이지에서도 최초 결과 목록은 유지하고 현재 파일의 변경·삭제·확인 불가
상태를 별도로 표시합니다. 60초 안에 같은 옵션으로 이어 읽고, 사용하지 않는
cursor는 해제합니다. 결과 범위는 과거 내용에 해당할 수 있으므로 편집 전에는
재조회와 기존 리비전 비교 저장을 사용합니다. 검색/감시로 편집 초안을 덮어쓰지
않습니다. SDK 0.9.0에서 제공하며 HTTP/project client에서도 같은 범위를 유지합니다.
