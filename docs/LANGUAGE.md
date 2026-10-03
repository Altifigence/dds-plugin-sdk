# Language features

SDK 0.3.0 adds completion, hover, definition, references and flat document symbols.
Run `node examples/hello-language/run.mjs` after installing the SDK. The example
implements a tiny teaching language; it is not a SystemVerilog compiler or LSP server.

Declare each feature in manifest v2 `capabilities`, and declare `document.read`
and `language.provide` in `permissions`. The host must explicitly grant both.
Upgrading a plugin or installing its package does not grant permission.

```js
context.registerLanguageProvider('hover', {languages: ['my-language']}, {
  provide(request, {signal}) {
    signal.throwIfAborted();
    return createLanguageResult(request, {text: 'A plain-text description'});
  },
});
```

Import `createLanguageResult` from `@altifigence/dds-plugin-sdk`. Registrations
return an idempotent disposable and are also owned by the plugin's host lifecycle.
For testing or an authorized custom host:

```js
const host = createPluginHost({grants: ['document.read', 'language.provide']});
await host.activate(plugin);
host.setDocument(snapshot);
const hover = await host.requestLanguage('hover', {
  position: {line: 0, character: 3},
}, {signal, timeoutMs: 1000});
```

| Feature | Input | Result `data` |
| --- | --- | --- |
| `completion` | `position` | Up to 500 `{label, insertText, detail?, range?}` items |
| `hover` | `position` | `{text, range?}` or `null` |
| `definition` | `position` | Up to 500 `{path, range}` locations |
| `references` | `position`, optional `includeDeclaration` | Up to 500 `{path, range}` locations |
| `document-symbols` | `{}` | Up to 500 `{name, kind, range, selectionRange, detail?}` symbols |

Positions are zero-based lines and UTF-16 code-unit offsets, including CRLF input.
Completion insertion is literal text, not snippets or commands. Hover and detail
strings are plain text: render them as text, never `innerHTML` or trusted Markdown.
The runtime validates current-document positions, ordered ranges and symbol
selection containment. Location paths are relative workspace paths; they do not
authorize a read, and a host must check target content/ranges before navigation.

Each result is bound to its request ID, project/session, URI, language, model
version and workspace revision. Changing the document aborts pending work; late
results are discarded even if a provider ignores its signal. Cancellation,
timeout, unregister, deactivate and host disposal settle outstanding requests.
Provider errors are redacted. Each feature registry allows 32 registrations and
64 concurrent requests; requests default to 5 seconds with a 30-second maximum.
Result envelopes are limited to 1.6 MB; completion insertion and hover text have
additional 16,384-character limits. Type declarations and JSON Schemas accompany
runtime validation; the runtime additionally checks UTF-8 budgets and document ranges.

Provider selection uses the highest selector priority, then earliest registration.
One provider answers each request. Document symbols are flat; this version does
not merge providers, auto-apply edits, execute completion commands or start LSP processes.

These APIs run in the SDK's trusted in-process host. They do not add editor UI
integration to a released DDS product, extend workspace HTTP protocol v1 or make
plugin code an OS sandbox. Existing manifests and diagnostics remain supported;
hosts older than 0.3.0 reject the new capabilities. See [compatibility](COMPATIBILITY.md).

## 한국어

SDK 0.3.0에서 자동완성·호버·정의·참조·문서 심볼 제공자를 등록할 수 있습니다.
manifest v2에 해당 capability와 `document.read`, `language.provide` 권한을
선언하고 호스트가 두 권한을 명시적으로 승인해야 합니다. 설치·업데이트만으로
권한이 생기지 않습니다. `examples/hello-language/run.mjs`는 다섯 기능을 실제로 실행합니다.

좌표는 0부터 시작하는 줄과 UTF-16 문자 위치입니다. 자동완성은 일반 삽입 문자열,
호버는 일반 텍스트이며 HTML·명령·스니펫으로 실행하지 않습니다. 정의·참조의
상대 경로는 파일 접근 권한을 부여하지 않습니다. 문서 변경, 취소, 시간 초과,
등록 해제 또는 호스트 종료 뒤의 결과는 폐기합니다. 결과의 요청 ID와 문서 버전도 확인합니다.

이 기능의 제공 범위는 공개 SDK 호스트입니다. DDS 제품 에디터 연결·설치 지원은
별도 제품 통합과 릴리스 검증이 필요합니다. SDK의 HTTP workspace protocol v1은 유지됩니다.
