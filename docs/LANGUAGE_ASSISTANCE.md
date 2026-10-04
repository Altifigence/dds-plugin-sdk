# Signature help and completion assistance

SDK 0.11 adds `signature-help`, lazy completion resolution and a bounded snippet
grammar to the trusted in-process language host. The original literal completion,
hover, definition, references and document-symbol APIs remain available.

Declare `signature-help`, `completion-resolve` and `completion-snippets` as needed
in manifest v2 `capabilities`; the last two also require `completion`. Registration
requires the existing `document.read` and `language.provide` grants. A completion
provider with a `resolve` method must declare `completion-resolve`, and a plugin
declaring that capability must supply the method. `host.languageCapabilities()`
describes the SDK implementation, without granting any plugin permission.

## Independent example

After installing the package, copy `examples/language-assistance` from the installed
package to your project and run `node language-assistance/run.mjs`. In this checkout,
run `npm run example:assistance`. It exercises nested calls, two signatures, CRLF,
Unicode, lazy resolution and insertion preview using only package imports.

```js
const result = await host.requestLanguage('signature-help', {
  position: {line: 0, character: 8},
  context: {triggerKind: 'character', triggerCharacter: ',', isRetrigger: false},
});
const list = await host.requestLanguage('completion', {position});
const detailed = await host.resolveCompletion(list.data[0].resolveToken);
const preview = host.prepareCompletion(detailed);
// Display preview.content and preview.tabstops to the user.
host.releaseCompletion(list);
host.releaseCompletion(detailed);
```

`position` and `host` above come from the embedding application's current document
and explicitly configured host. Resolution is optional: a literal completion can
go directly from `requestLanguage` to `prepareCompletion`. Preparation is pure:
it returns `{snapshot, content, edits, tabstops}` and performs no document/file write.

## Signature and trigger contracts

`signature-help` returns `null` or `{signatures, activeSignature, activeParameter}`.
Each signature has a nonempty plain-text `label`, `parameters`, and optional plain
`documentation`. Parameter labels are nonempty `[start, end]` UTF-16 offsets into
the signature label. Active indices must exist; `activeParameter` is `null` only
when the selected signature has no parameters. Limits are 16 signatures, 64
parameters per signature, 2,048 UTF-16 units per label and 16,384 per documentation.

Optional signature context uses `triggerKind` of `invoked`, `character` or
`content-change`, required `isRetrigger`, and optional active indices on retriggers.
Completion context accepts `invoked`, `character` or `incomplete`. Only a `character`
trigger has a required single Unicode `triggerCharacter`; CR, LF and NUL are rejected.
The SDK carries context; the language provider decides which call/signature is active.

## Lazy completion resolution

A provider can return a completion item with bounded plain-JSON `resolveData`
(4 KiB). The host removes it from the visible list and substitutes a one-use
`resolveToken`. `resolve(request, originalItem, {signal})` receives the original
request and item, and returns one completion item with optional documentation,
detail and additional text edits. Label, insertion text, insertion format and the
effective main range must stay unchanged. Unknown executable fields are rejected.

Tokens are bound to the issuing registry, provider registration, full snapshot,
scope, request and selected item. They expire after 60 seconds, and are cleared
on document changes, unregistration, plugin deactivation and host disposal. Editing
and restoring the same text does not revive a token. A resolve attempt consumes its
token even if invalid options, cancellation, timeout or capacity prevents success;
request a new list for a new attempt. The host retains at most 128 tokens and 4 MiB
of charged request/item data, with at most four actual resolver operations at once.
Expired tokens are removed on the next registry operation; there is no background
expiry timer. Release unused results explicitly to reclaim retained data sooner.

The 64-operation limit per feature counts actual provider work, including cancelled
operations whose provider ignores its signal. Consumer cancellation settles promptly,
but does not manufacture free provider capacity. Default timeout is 5 seconds and
maximum timeout is 30 seconds. Late or stale results never become insertions.

## Snippet subset and insertion

Items remain literal unless `insertTextFormat: 'snippet'` is explicit and the plugin
declares `completion-snippets`. Supported syntax is `$n`, `${n}`, `${n:literal}` and
one `$0`, with indices 0..99. Escape backslash, dollar and braces with a backslash.
Mirrors share one consistent literal default, including forward references. Tab
navigation visits positive indices in ascending order, then zero; when absent,
zero is appended at the end. Variables, nested placeholders, choices and transforms
are rejected. There are at most 128 explicit stops and 16,384 UTF-16 units in both
source and expanded text. `parseSnippet` returns text and numeric UTF-16 offsets.

`prepareCompletion` accepts only the actual result object returned by that host.
It converts snippet offsets into document ranges, accounting for up to 32 additional
edits before the insertion. All edits are relative to the original snapshot and
must have valid, non-overlapping ranges; ambiguous shared insertion points, split
surrogates/CRLF, out-of-document ranges and oversized final files are rejected.
Changing the document or releasing a result invalidates its preview. The caller
must obtain fresh authority and check revisions before separately applying edits.

All labels, detail and documentation are display text, including strings that look
like HTML. Render as text. These APIs do not execute commands, download resources,
extend workspace HTTP protocol v1 or establish product editor support. JSON Schemas
cover structure; runtime validation additionally checks UTF-16 lengths, snippet
grammar, actual document ranges, UTF-8 budgets and identity.

## 한국어

0.11은 함수 서명/인자 안내, 선택한 자동완성 항목의 지연 해석, 제한된 스니펫을
공개 SDK 호스트에 추가합니다. manifest capability와 기존 문서 읽기/언어 제공
권한을 명시해야 합니다. 토큰은 현재 문서와 제공자에 묶이며 60초 후 만료되고,
문서 변경·등록 해제·호스트 종료 뒤에는 사용할 수 없습니다. 취소를 무시한 제공자는
실제 처리가 끝날 때까지 동시 실행 한도를 차지합니다.

삽입 준비는 텍스트와 UTF-16 탭 이동 범위를 계산하는 미리보기입니다. 파일을 자동
변경하거나 HTML·명령을 실행하지 않습니다. 실제 적용은 별도의 현재 권한·버전
확인이 필요합니다. 예제는 중첩 호출에서 안내할 함수를 선택하고, 자동완성 선택 후
상세 정보를 해석하여 CRLF/Unicode 문서의 삽입 미리보기를 확인합니다.
