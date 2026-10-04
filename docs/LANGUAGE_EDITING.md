# Formatting and diagnostic code actions

SDK 0.11 adds `format-document`, `format-range`, `code-actions` and optional
`code-action-resolve` to the trusted in-process language host. Declare each used
feature in manifest v2 with `document.read` and `language.provide` grants. A resolver
also requires `code-actions` and an actual provider `resolve` method. These grants
only permit proposals; they do not grant workspace mutation.

Run `npm run example:language-editing`, or copy `examples/language-editing` from the
installed package and run `run.mjs`. The example trims selected/document whitespace,
preserves CRLF and Unicode, previews a diagnostic quick-fix, detects an external
edit, and applies only the newly reviewed selected fix through a real HTTP client
and persistent journal. Another TODO and the external edit remain unchanged.

## Format requests and results

```js
const formatted = await host.requestLanguage('format-range', {
  path: 'main.dds',
  range: {start: {line: 0, character: 0}, end: {line: 5, character: 0}},
  formatOptions: {tabSize: 2, insertSpaces: true, trimTrailingWhitespace: true},
});
const proposedEdit = host.prepareFormatting(formatted);
```

Use `format-document` without `range` for the whole document. Both require an
explicit workspace-relative path and `formatOptions`; neither takes `position`.
Options require `tabSize` (1..16) and boolean `insertSpaces`. Optional booleans are
`trimTrailingWhitespace`, `insertFinalNewline` and `trimFinalNewlines`. The language
provider interprets formatting policy and may return no proposal.

Optional `endOfLine` is `preserve` (default), `lf` or `crlf`. Inserted/replacement
newlines must use the selected style. Preserve allows the newline styles already
present in the source; it uses LF when there are none. Unedited text keeps its
original bytes, including when a range formatter uses an explicit different style.

A provider returns `null` or a `WorkspaceEdit` containing exactly one `edit` for the
requested path, with the SHA-256 of the current snapshot text as `baseRevision`.
Every UTF-16 edit must be valid and non-overlapping. Range formatting additionally
requires every edit, including insertions, to stay within the selection. Edits cannot
split a surrogate or CRLF, use a different file/base or exceed the final file budget.
The host normalizes content-identical proposals to `null`; return `null` when there
are no edits. Empty change lists are invalid. `prepareFormatting` accepts the actual
host result object and rejects stale or foreign results. It performs no write.

## Diagnostic identity and actions

```js
await host.requestDiagnostics();
const actions = await host.requestLanguage('code-actions', {
  path: 'main.dds', range: selectedRange,
  context: {triggerKind: 'invoked', only: ['quickfix']},
});
const selected = actions.data[0];
const resolved = selected.resolveToken
  ? await host.resolveCodeAction(selected.resolveToken) : actions;
const proposedEdit = host.prepareCodeAction(resolved, 0);
// Preview proposedEdit with the separately connected workspace client.
host.releaseCodeActions(actions);
host.releaseCodeActions(resolved);
```

Only proceed when an action exists and is enabled. `only` is optional and accepts
the finite exported `CODE_ACTION_KINDS`. `refactor` also matches its declared
sub-kinds. Context defaults to `{triggerKind: 'invoked'}`; the alternative is
`automatic`. Requests require a selected `range` and explicit `path`.

The host supplies a request-only `diagnosticContext` with a monotonic `revision`
and the currently accepted diagnostic list for that document. Caller input cannot
forge this bundle. Before the first accepted diagnostic publication it is empty.
Accepted diagnostic results invalidate all retained action selections and resolve
tokens, even if their text is unchanged. Provider registration/disposal and document
replacement clear the bundle. Out-of-order diagnostics may still return to their
original caller, preserving that API, but never replace a newer accepted action
context. An unsuccessful diagnostic request does not publish a new bundle.

Each action has a plain-text `title`, a `kind`, optional `isPreferred`, optional
`diagnosticIndices` into that exact bundle, and an `edit`, private `resolveData`,
or a `disabled: {reason}` value. Disabled actions cannot carry edits/resolvers.
Kinds are `quickfix`, `refactor`, `refactor.extract`, `refactor.inline`,
`refactor.rewrite`, `source.organizeImports` and `source.fixAll`.

An action can propose other files through workspace-relative `WorkspaceEdit`
changes; those files require authorized preview reads and current CAS before apply.
Edits to the current request path must already match the snapshot hash and valid
text geometry. Action edits may extend beyond the selected range (for example a
file-wide fix or refactor); the complete plan must be shown during review.

## Lazy resolution, bounds and apply

The host replaces `resolveData` with a one-use opaque token bound to the provider,
document, request path/range, diagnostic revision/bundle and selected item. The
resolver receives the original request and item. It may supply an edit or disable
the action, but cannot change title, kind, preferred status or diagnostic references.
Commands, shell arguments, URLs and unknown executable fields are rejected.

Limits are 100 actions, 256 UTF-16 units per title, 2,048 per disabled reason and
500 distinct diagnostic indices. Shared resolver limits are 4 KiB private data,
128 retained tokens, 4 MiB charged request/item data, 60-second expiry and four
actual resolver operations per feature. Each feature still has at most 64 actual
pending operations. Cancelled providers that ignore their signal retain their
slot until settlement; late results are discarded. Consumed or expired tokens
require a new request, not automatic replay. Release unneeded lists explicitly.

`prepareCodeAction` checks that the actual result still belongs to the active host
and provider and that the document and diagnostic revision remain current. It
rejects disabled or unresolved selections. It returns only a proposal. Use
[`previewWorkspaceEdit` and reviewed apply](WORKSPACE_EDITS.md) for current file
versions, user review, authorization, durable intent and partial-failure receipts.
Diagnostic/formatting capabilities never act as approval for that separate step.

All returned strings are display text. Render even HTML-looking titles/reasons as
text. No new workspace HTTP method, command execution mechanism or DDS product
editor support is established by these SDK APIs. Existing diagnostics, literal
completions and single-file `saveEdits` remain supported.

## 한국어

문서/범위 포맷팅과 코드 액션은 수정안만 반환합니다. 포맷팅은 현재 파일·내용 해시와
UTF-16 범위를 확인하며, 선택 범위 밖 수정과 겹치는 삽입을 거부합니다. 변경이 없으면
`null`을 반환하고 기존 CRLF는 기본 정책에 따라 보존합니다.

코드 액션에는 호스트가 관리하는 최신 진단 묶음과 revision이 연결됩니다. 진단 갱신,
문서 변경, 제공자 해제 뒤에는 이전 선택과 지연 해석 토큰을 사용할 수 없습니다.
선택한 수정안도 별도의 파일 미리보기·정확한 계획 해시 검토·현재 권한·CAS를 거쳐야
적용됩니다. 표시 문자열을 HTML이나 명령으로 실행하지 않습니다.
