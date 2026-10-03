# Verify a release without running it

From the SDK checkout, run `npm run example:verify`. The example copies the
adjacent publishable plugin into a new temporary directory, packs it, verifies
the paired archive/metadata and rejects altered bytes against the original
SHA-256. It removes only its own temporary files. No plugin module is imported,
no package is installed and no archive is extracted.

The local example produces both the archive and its hash. For a real download,
obtain an expected hash independently from a trusted publisher channel. An
adjacent checksum file alone cannot establish publisher identity or code safety.

The example is included in the released SDK. In an ESM project with that SDK
installed, run it directly from the package:

```js
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {pathToFileURL} from 'node:url';

const require = createRequire(import.meta.url);
const root = dirname(require.resolve('@altifigence/dds-plugin-sdk/package.json'));
await import(pathToFileURL(join(root, 'examples/release-verification/run.mjs')).href);
```

For your own downloads, use the [verification guide](../../docs/VERIFYING.md).

## 한국어

SDK 저장소에서 `npm run example:verify`를 실행합니다. 임시 디렉터리에 게시
예제를 복사하여 패키지를 만들고, 아카이브와 메타데이터를 검증한 다음 원래
SHA-256과 다른 파일을 거부합니다. 플러그인 실행·설치·압축 해제는 하지 않으며
예제가 만든 임시 파일만 정리합니다. 실제 내려받은 파일의 예상 해시는 신뢰하는
발행자의 별도 경로에서 확인하세요. 함께 받은 체크섬만으로 출처나 안전성을
확인할 수는 없습니다.
