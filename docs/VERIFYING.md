# Verify a downloaded plugin release

SDK **0.5.0** provides a Node.js API and CLI for checking archives produced by the
**0.3.x, 0.4.x or 0.5.x DDS plugin packer**. Keep the publisher's `.tgz` and corresponding
`.tgz.release.json` together. Verification reads these local files without
extracting them, importing a plugin, running a package script or installing it.
It makes no network requests.

## Check an archive

```sh
dds-plugin verify ./example-hello-publisher-1.0.0.tgz
```

The metadata path defaults to the archive path plus `.release.json`. For a
renamed download or metadata file, provide `--metadata`:

```sh
dds-plugin verify ./download.tgz --metadata ./release.json
```

Obtain the archive's expected SHA-256 independently from a trusted release
channel and supply its 64 lowercase hexadecimal characters with `--sha256`.
The same option is available as `expectedSha256` in the API:

```js
import {verifyPluginArchive} from '@altifigence/dds-plugin-sdk/publishing';

const receipt = await verifyPluginArchive(process.argv[2], {
  metadataPath: process.argv[3],
  expectedSha256: process.argv[4],
});
console.log(receipt.pluginId, receipt.pluginVersion, receipt.artifact.sha256);
```

Save that code as `verify.mjs` in an ESM project with SDK 0.5.0 installed. Run it
with the archive path, metadata path and independently obtained hash as its
three arguments. The API returns a frozen report, and the CLI serializes it as
JSON. The report contains the plugin
identity, source visibility, manifest/disclosure hashes, exact file inventory,
unpacked size and archive filename/size/hash. `checksumPinned` is true only when
a supplied expected hash matched. CLI rejection exits with code 1.

For a complete temporary package/verification/tampering example, run
`npm run example:verify` in the SDK checkout, or use the
[installed-package example](../examples/release-verification/README.md).

## What is checked

- The compressed archive's size and SHA-256 match the external metadata and any
  independently supplied expected hash.
- A single bounded gzip member contains the DDS packer's regular-file ustar
  format. Checksums, paths, sizes, headers, padding and terminal blocks are checked.
  Links, directories, PAX/GNU extensions, duplicate/case-colliding paths, path
  traversal, appended members and trailing input are rejected.
- The archive contains exactly the files selected by `dds-package.json`, plus
  its generated `package.json` and the configuration itself. File/directory path
  conflicts, missing files and unlisted files are rejected.
- The manifest, disclosure, entry module and nonempty license file are checked
  by the same rules used for packaging. The generated npm metadata must match;
  added scripts, dependencies or altered SDK peer requirements are rejected.
- Every file's size and SHA-256 match the release inventory. Recognizable
  credentials and private configuration paths are rejected without echoing
  detected values.

Limits are 12 MiB compressed input, 10 MiB total file contents, 4 MiB per file,
256 archive entries, 64 KiB package configuration and 256 KiB release metadata.
Decompression also bounds tar headers and padding. The verifier supports this
specific DDS package format; it is not a general npm/tar archive validator.

## Trust and compatibility

The paired metadata is not signed. A person who can replace both files can
produce new matching hashes. A pinned hash identifies the exact bytes selected
through your trusted channel; it does not inspect their behavior or establish
the publisher's identity by itself. Verification is not malware scanning,
signature validation, isolation, installation consent or a DDS compatibility
qualification. Read the publisher's license, data disclosures and source/access
conditions, and use the host's explicit permission and isolation controls.

The receipt describes the bytes read during that call. If another process can
change a download before installation or use, recheck the expected hash on the
actual bytes being consumed. A report is not a grant to execute a mutable path.

0.5.0 preserves existing runtime/workspace contracts and verifies exact 0.3.x
metadata (`>=0.3.0 <0.4.0`), 0.4.x metadata (`>=0.4.0 <0.5.0`) and new 0.5.x
metadata (`>=0.5.0 <0.6.0`).
Verification does not alter the peer range or authorize installation on another
SDK line: validate and repack a new version for 0.5. Existing 0.3.x/0.4.x packages that
satisfy the strengthened file policy can be verified unchanged. The verifier rejects private
credential names and Windows device aliases; remove them and publish a new
plugin version if needed. See [Security](../SECURITY.md).
Archives made with 0.2.x CLI metadata need the migration described in
[compatibility](COMPATIBILITY.md). This command verifies plugin packages, not the
SDK's own npm release tarball.

## 한국어

SDK **0.5.0**의 `dds-plugin verify`와 `verifyPluginArchive()`는 **0.3.x·0.4.x·0.5.x DDS
플러그인 packer**가 만든 `.tgz`와 외부 `.tgz.release.json`을 검사합니다.
플러그인을 실행·설치하거나 파일을 디스크에 추출하지 않으며 네트워크 요청도 하지
않습니다. 실행 명령과 API는 위 예제와 같습니다. 별도 위치의 메타데이터는
`--metadata`, 신뢰하는 경로에서 따로 확인한 64자리 소문자 SHA-256은
`--sha256` 또는 `expectedSha256`으로 전달합니다.

검사 대상은 압축 파일·각 파일의 크기와 해시, gzip/ustar 구조, 명시적 파일 목록,
manifest·발행자 고지·진입 모듈·라이선스 및 생성된 npm 메타데이터입니다. 경로
이탈·링크·특수 tar 항목·중복 경로·추가 파일·실행 스크립트와 의존성 삽입·알려진
비밀정보를 거부합니다. 압축 입력은 12 MiB, 파일 합계는 10 MiB, 파일당 4 MiB,
항목은 256개, 패키지 설정은 64 KiB, 릴리스 메타데이터는 256 KiB로 제한합니다.
실패한 CLI는 종료 코드 1을 반환합니다.

`checksumPinned`는 호출자가 따로 전달한 예상 해시가 일치했을 때만 true입니다.
함께 받은 메타데이터에는 서명이 없으므로 두 파일을 모두 바꿀 수 있는 사람은
일치하는 새 해시도 만들 수 있습니다. 해시 일치는 발행자 인증·악성코드 검사·OS
격리·설치 동의·DDS 제품 호환성 검증을 대신하지 않습니다. 실제 실행 시 파일이
바뀔 수 있는 환경에서는 소비하는 바로 그 파일의 해시를 다시 확인해야 합니다.

강화된 파일 정책을 만족하는 기존 0.3.x·0.4.x 플러그인 아카이브는 그대로 검증할 수 있고
각각 기존 peer 범위도 유지됩니다. 새 패키지는 `>=0.5.0 <0.6.0`을
선언하며, 기존 패키지를 0.5에 설치하려면 발행자가 검증 후 새 버전으로 패키징해야
합니다. 검증 자체는 호환 범위를 바꾸지 않습니다. 제외한 자격증명 경로나 Windows
장치명이 들어 있으면 해당 파일을 제거한 새 플러그인 버전을 발행하세요.
0.2.x 아카이브는 기존 마이그레이션 안내에 따라
새 플러그인 버전으로 검증·패키징하세요. 이 명령은 플러그인 아카이브용이며
SDK 자체의 npm tarball을 검증하는 명령은 아닙니다.
