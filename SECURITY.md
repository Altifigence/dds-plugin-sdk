# Security

The current stable API release is **1.2.0**. It retains the security fixes from
0.3.2. Update workspace servers and clients together, using a current patched
Node 22 or 24; do not use a pre-0.3.2 workspace host.
Report an SDK
validation, lifecycle or permission-boundary vulnerability through
[private vulnerability reporting](https://github.com/Altifigence/dds-plugin-sdk/security/advisories/new).
If the form is unavailable, ask maintainers for a private contact without posting
exploit details or project data in an issue.

Include the SDK version, a minimal synthetic reproducer, expected behavior and
impact. Omit credentials, customer source and private filesystem paths.

The post-0.7 security audit and vulnerability validation are pending under the
owner's 2026-10-05 deferral. Functional and release checks do not complete that
audit or establish that its unvalidated candidates are resolved.

## 0.3.2 boundary fixes

The review reproduced file-access and resource-lifetime gaps in 0.3.1 with
synthetic files and a local test server. The patch rejects hardlink aliases of
excluded or outside files and aligns the explicit credential-name exclusions
used by workspace access and packaging. Cross-platform validation also rejects
Windows device aliases before filesystem access. It bounds HTTP uploads before
buffering and closes rejected or stalled client response streams.

Upgrade both the operator's host and SDK clients; updating a client cannot add
the server-side file and admission checks to an older host. Copy a hardlinked
project file to a normal single-link file when it is intentionally shareable.
Remove excluded credential files from plugin allowlists and publish a new plugin
version. Existing 0.3.x archives that satisfy the strengthened policy remain
compatible. No receipt, token or existing consent is silently broadened.

The tests establish these specific boundaries. They do not establish that every
secret format is detected, that no vulnerabilities remain, or that an arbitrary
plugin is safe. See the [changelog](CHANGELOG.md) and
[workspace guide](docs/WORKSPACES.md) for the exact behavior and limits.

The local developer host runs trusted plugins in the same process. It is not a
security sandbox and cannot stop a plugin's synchronous loop or ambient Node
access. A signed archive or successful test does not establish plugin safety.
Production adapters are responsible for isolation, grants, quotas and revocation.

The user-owned workspace server requires an explicit token and root. It exposes
operator-selected plugins and fixed backend handlers. Use HTTPS for remote
connections, keep tokens out of URLs and logs, and restrict the operating-system
account/container running the host. The sample host does not authenticate a
publisher, scan code for malware or prevent a trusted plugin from using ambient
process privileges. File checks protect the API path; they do not isolate the
host from a hostile administrator or another process that can modify the root.

Packaging reads only explicitly listed files and blocks common private key and
configuration names plus recognizable key/token content. Public package inventory
and source checks are described in [Public scope](docs/PUBLIC_SCOPE.md).
These are not complete secret scanners. Inspect the archive
before publishing. Consent receipts are unsigned local records; consumers must
protect storage, verify the current identity and implement revocation themselves.

## 한국어

현재 안정 API 릴리스는 **1.2.0**이며 0.3.2의 보안 수정을 유지합니다. workspace **서버와 클라이언트를 모두
0.3.2 이상**으로 갱신하고 Node 22/24의 최신 보안 패치를 사용하세요. 클라이언트만
갱신하면 오래된 서버의 파일 검사와 요청 수신 제한은 바뀌지 않습니다.

0.3.1에서 합성 파일과 로컬 서버로 재현한 하드링크를 통한 파일 노출, 일부 자격증명
경로 누락, 본문 수신 제한과 응답 스트림 정리 문제를 수정했습니다. 공유할
하드링크 파일은 일반 파일로 복사하고, 새로 제외된 경로가 들어 있는 플러그인은
해당 파일을 제거한 새 버전으로 패키징하세요. 보호 목록에 없는 모든 비밀정보를
탐지한다는 의미는 아닙니다. 플러그인은 여전히 호스트 프로세스 권한으로 실행되므로
신뢰할 수 있는 코드만 구성하고 실제 실행 격리는 운영자가 제공해야 합니다.

## Binary result boundary

Binary results are opt-in and retain the protected-path and link policy. Registered
files are pinned by SHA-256 and size, with metadata rechecked around chunk reads.
The Node downloader hashes the entire stream and the actual staging file before
exclusive publication. Partial files are not verified results. This is not a lock
against hostile processes with write access to the workspace or download directory.
Custom ports must enforce equivalent isolation and coherent-source checks.

## 1.x review and support

See the [support policy](docs/SUPPORT_POLICY.md) for maintained lines, runtime end
dates and deprecated APIs, and [conformance](docs/CONFORMANCE.md) for test scope.
Durable state, upload staging and workspace edit journals are operator-owned;
recovery requires current authority and does not replay execution automatically.
Synthetic tests and local diagnostic exports contain no real customer fixtures.
Conformance results and unsigned package hashes do not grant trust or permissions.
