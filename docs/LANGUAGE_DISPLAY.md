# Semantic tokens, folding, hints and symbol trees

SDK 0.11 adds four optional features to the trusted in-process host. Declare each
feature in manifest v2, with `document.read` and `language.provide` permissions and
matching host grants. This guide describes SDK APIs and the public teaching
example. It does not establish a released DDS editor bridge or an LSP connection.

| Feature | Request input | Result data |
| --- | --- | --- |
| `semantic-tokens` | `{previousResultId?}` | Full normalized `{resultId, legend, data, updateKind}` |
| `folding-ranges` | `{}` | Ordered `{range, kind?, collapsedText?}` array |
| `inlay-hints` | `{range}` | Ordered `{position, label, kind?, paddingLeft?, paddingRight?, tooltip?}` array |
| `document-symbol-tree` | `{}` | Hierarchical document symbols with optional `children` |

The older `document-symbols` feature keeps its flat shape and 500-item limit.
All coordinates use zero-based lines and UTF-16 code units. Runtime validation
rejects positions outside the requested document and positions splitting a
surrogate pair. Labels and tooltips are plain text; they cannot contain commands,
links with executable behavior or arbitrary presentation fields.

## Semantic data and incremental updates

The legend has `tokenTypes: [{name, style}]` and `tokenModifiers: [name]`. Type
names are unique ASCII identifiers; style is one of `SEMANTIC_STYLE_KEYS`:
`plain`, `keyword`, `type`, `function`, `variable`, `number`, `string`, `comment`,
`operator`. Map only these keys to host-owned styles. A modifier name is data;
apply only modifier styling that the host explicitly recognizes.

Each token uses five integers: delta line, delta start character, positive
length, legend type index and modifier bitset. A nonzero line delta makes the
start character relative to the new line. Tokens are ordered, nonoverlapping and
confined to one line. `decodeSemanticTokens(data, documentText)` validates and
returns explicit ranges and style names. Limits are 20,000 tokens, 64 types and
16 modifiers, within the 1.6 MB result envelope.

An ordinary provider returns `createLanguageResult(request, {resultId, legend,
data})` from `provide`. Its result ID is private to that provider. The host replaces
it with a secure UUID handle and always returns a full array to the UI, with
`updateKind: 'full' | 'delta' | 'fallback'`.

To enable deltas, also declare `semantic-tokens-delta` and implement
`provideDelta(request, previous, {signal})`. `previous` contains the provider's
result ID, old snapshot identity, legend and integer array; it excludes old
document text and the host UUID. Return `null` if a full recomputation is needed,
or `{baseResultId, resultId, edits: [{start, deleteCount, data?}]}`. Edits address
positions in the original integer array, not token or character positions. Up to
64 edits must be ordered and disjoint; insertion points cannot repeat. The host
validates the whole reconstructed array against the new document.

Pass a host handle back as `previousResultId` after a document edit. The cache
retains at most eight results and 4 MiB, with a 60-second lifetime and LRU eviction.
It binds provider, project/session, URI and language. Ordinary monotonic model
updates preserve the base while invalidating the old display result. Document
replacement, nonmonotonic version reset, unregister, deactivate and disposal
clear affected bases. A provider change cannot consume another provider's base.

An unknown, expired or evicted handle, absent delta capability, `null` delta, or
different provider base ID triggers at most one full request. Both operations
share the caller's cancellation and original time budget. Invalid delta data,
provider exceptions and cancellation fail the request; they do not trigger a
retry. Ignored cancellation retains the real operation's concurrency slot until
the provider settles.

## Rendering and release

Before painting, call `host.validateLanguageResult(result)`. It accepts only the
actual result owned by that host, with a current snapshot and active provider;
a copied, released or stale result fails. `host.releaseLanguageResult(result)`
releases its semantic base and display ownership. Using an old handle as a delta
base never makes that old result valid for display.

Folding accepts 1,000 nonempty ranges, ordered outer-first, with nesting depth at
most 32. Crossing and duplicate ranges are invalid. Inlay hints accept 1,000
items within the requested range; labels are single-line, up to 1,024 UTF-16
units, and tooltips up to 4,096. Symbol trees contain at most 1,000 total symbols
and 16 levels. Children and selections must be inside their parent range;
siblings are ordered and nonoverlapping. Result ownership checks apply to all
four features, and existing language features can use the same validation API.

Run the independent installed-package example:

```sh
npm run example:language-display
npm run example:language-display-browser
```

Open the loopback URL printed by the second command. The example uses text nodes
and an explicit style whitelist, with no `innerHTML`. Exercise full refresh,
edit/delta, discarded-base fallback, folding, symbol navigation, deactivate and
restart. One hint intentionally displays `<img src=x onerror=alert(1)>` literally.
The example implements a teaching grammar and uses no engine or external service.

## 한국어

0.11의 의미 토큰·접기·인레이 힌트·계층형 심볼은 공개 SDK 호스트의 선택 기능입니다.
각 capability와 문서 읽기·언어 제공 권한을 선언하고 호스트에서 승인해야 합니다.
화면에 표시하기 직전 `validateLanguageResult`로 현재 문서와 제공자 소유권을 확인합니다.
문서 변경 후 이전 강조 결과는 표시할 수 없지만, 제한된 캐시가 남아 있으면 증분 계산의
기준으로 사용할 수 있습니다. 기준을 잃으면 남은 시간 내 전체 요청을 한 번 수행합니다.
라벨은 일반 텍스트이며 접기 범위·심볼 포함 관계·UTF-16 좌표를 검증합니다.
DDS 제품 에디터 연결과 실제 언어 서버 지원은 별도 통합 및 검증 범위입니다.
