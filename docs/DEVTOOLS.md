# Plugin development tools

SDK 0.4.0 adds `init`, `doctor` and `dev` to the existing `validate`, `pack` and
`verify` CLI. Node 22 or 24 is required. These tools operate on your local project;
they do not publish a plugin or change an installed DDS application.

## Create a project

Install the released SDK in a tools directory, then create a sibling project:

```sh
mkdir dds-tools
cd dds-tools
npm init -y
npm install --ignore-scripts --save-exact https://github.com/Altifigence/dds-plugin-sdk/releases/download/v0.7.0/altifigence-dds-plugin-sdk-0.7.0.tgz
npx --no-install dds-plugin init ../my-plugin --id my-plugin --publisher example
cd ../my-plugin
npm install --ignore-scripts
npm run doctor
npm test
```

The destination must not exist and its parent must exist. `init` never replaces
files, installs dependencies, runs scripts or imports code. It writes a command
plugin and test, manifest, disclosure, explicit packaging file list, development
`package.json`, README, `.gitignore`, Apache-2.0 LICENSE and NOTICE. The generated
SDK dependency is pinned to this release's GitHub archive. Use `--name` for the
display name; IDs use lowercase identifiers such as `my-plugin`.

Review the inherited license and NOTICE and replace the example publisher and
support URL before distributing your plugin. The development `package.json` is
private; `pack` generates separate inert consumer metadata.

## Diagnose without executing

```sh
npx --no-install dds-plugin doctor .
npx --no-install dds-plugin doctor . --json
```

Checks cover the Node major version, local SDK 0.7.x resolution, manifest,
disclosure, license, allowlisted files and example publisher metadata. Each check
has `id`, `status`, `message` and an optional suggested `fix`. Errors set exit
status 1; warnings alone do not. Doctor reads metadata and file bytes. It never
imports the entry module, invokes npm scripts, installs packages or executes
tools. A passing report does not prove plugin behavior, dependency security,
publisher identity or legal eligibility.

## Run and watch trusted code

```sh
npx --no-install dds-plugin dev . --trust-local-code
npx --no-install dds-plugin dev . --trust-local-code --command greet --input '{"name":"Ada"}'
npx --no-install dds-plugin dev . --trust-local-code --command greet --input '{"name":"Ada"}' --job
npm run dev
```

`--trust-local-code` is required because imports and activation execute local
JavaScript with your operating-system account's authority. A child process is
used for restart and cleanup; it is **not a security sandbox**. It inherits your
environment, except `NODE_OPTIONS` is cleared. Do not run untrusted code or treat
SDK permission checks as protection against a malicious direct Node import.

With no command, dev activates the plugin and prints its commands. The test host
has no workspace or backend grants. Configure a separate explicit workspace host
for file and tool integrations. `--job` runs a command as a job and prints its
progress, logs and terminal result. `--input` accepts one JSON value. Ordinary
commands accept `--timeout-ms` from 1 to 30,000; jobs accept up to 1,800,000.
The default dev timeout is 30,000 ms, plus a 1-second process cleanup margin.

`--watch` polls only the allowlisted package files and `dds-package.json`, with
150 ms debounce. It revalidates before each run, restarts the entry and its ESM
imports in a fresh child, and waits for file corrections after a validation
error. Undeclared files, `node_modules` and build outputs are not watched. Add
distributable imported files to the allowlist; rerun dev after dependency changes.
Each run permits 256 KiB of combined stdout/stderr. Ctrl+C or an API AbortSignal
stops watching and cleans up the owned process tree. Windows uses `taskkill /T`;
Unix uses the child process group. Trusted code must not detach descendants or
terminate the supervisor worker itself; escaped processes are outside this
cleanup mechanism. A timeout is not a rollback of file or network side effects.

## Node API

```js
import {initPlugin, doctorPlugin, runPluginDev} from '@altifigence/dds-plugin-sdk/devtools';

await initPlugin('./new-plugin', {id: 'new-plugin', publisher: 'example'});
const report = await doctorPlugin('./new-plugin');
if (report.ok) {
  await runPluginDev('./new-plugin', {
    trustLocalCode: true,
    command: 'greet', input: {name: 'Ada'},
    onEvent: event => console.log(event),
  });
}
```

Install the generated dependency before expecting `report.ok`. The API never
installs it implicitly. `runPluginDev` resolves `{ok, runs, stopped}` after a
single run or after watch is stopped. The CLI exits unsuccessfully for a failed
single run, invalid configuration, timeout or output overflow.

## 한국어

0.4.0의 `init`은 존재하지 않는 새 디렉터리에 명령 플러그인과 배포용 메타데이터를
만듭니다. 기존 파일을 덮어쓰거나 의존성을 설치하지 않습니다. 생성된 프로젝트에서
`npm install --ignore-scripts` 후 `npm run doctor`로 확인하세요. `doctor --json`은
자동화용 결과를 제공하며 플러그인 코드를 실행하지 않습니다.

`dev --trust-local-code`는 신뢰하는 로컬 코드를 별도 프로세스에서 실행합니다.
`--watch`는 배포 허용 목록에 있는 파일이 바뀌면 검사 후 다시 실행하며, `--job`은
진행률과 로그를 출력합니다. 별도 프로세스는 OS 샌드박스가 아닙니다. 기본 개발
호스트에는 파일·백엔드 권한이 없고, 파일/외부 도구 연동은 별도 workspace 호스트에
명시적으로 설정해야 합니다. 배포 전 publisher, 지원 URL, 라이선스, 데이터 사용
설명을 실제 동작에 맞게 바꾸세요.
