# Run files, plugins and tools in your environment

`workspace-node` starts an authenticated Node host rooted at a user-selected
directory. `workspace-client` reads, edits and invokes configured plugin commands
through [protocol 1](workspace-protocol.md). Project files, plugin source and
tool execution remain in that host's environment. This may be local Windows,
WSL, a container or an operator-managed remote server. The desktop connection
uses this protocol; SDK clients can also connect directly.

The package does not create a cloud workspace, install tools or dynamically
load code from requests. The server imports only plugin modules its operator
explicitly configured. Plugins run as trusted JavaScript in the server process,
with the OS user's ambient access. API grants are not a security sandbox or
malware assessment. Use a restricted OS/container account for untrusted code;
this SDK does not provide that isolation.

## Try the actual host and tool

Use Node 22 or 24. From this repository (or its unpacked SDK package), create an
explicit random token in the host environment. Do not put the token on the command
line, in URLs, in source control or in logs. A secret manager is preferable for
persistent deployment.

PowerShell, first terminal:

```powershell
$env:DDS_WORKSPACE_TOKEN = node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
node examples/user-workspace/server.mjs
```

Provide the same token through the second terminal's environment, then run:

```powershell
node examples/user-workspace/client.mjs http://127.0.0.1:4777
node examples/user-workspace/client.mjs http://127.0.0.1:4777 --edit
```

The client lists `design.sv`, invokes `inspect`, and receives a real child process
result with `tool:'module-counter'`, one module and its process ID. `--edit`
invokes `append-note`, persists a comment in the server's `project/design.sv`,
and rereads the actual file. Run against a disposable project to try writes.
`list` demonstrates omitted parameter metadata (arbitrary bounded JSON input;
this command ignores its input). The server never prints the
token. Stop it with Ctrl+C.

Pass your own directory as the host's first argument:

```powershell
node examples/user-workspace/server.mjs C:/Users/me/projects/chip
```

For WSL/Linux/container shells, inject `DDS_WORKSPACE_TOKEN` into that environment
and run the same Node command with a Linux path:

```sh
node examples/user-workspace/server.mjs /home/me/projects/chip
```

The SDK package and `plugin.mjs` run in the same user environment as that directory.
A remote deployment needs an operator-managed HTTPS reverse proxy, access policy
and secret storage. The example binds `127.0.0.1`; an explicitly configured
`DDS_WORKSPACE_BIND`/`DDS_WORKSPACE_PORT` changes binding. A container must map its
project volume and configured listening port deliberately. Do not expose a
plain HTTP host on the public network. The client accepts remote HTTPS or
loopback HTTP and rejects redirects.

## Configure your own plugin and preinstalled backend

```js
import {createWorkspaceServer, createProcessBackend} from '@altifigence/dds-plugin-sdk/workspace-node';
import plugin from './my-reviewed-plugin.mjs';

const server = await createWorkspaceServer({
  root: '/home/me/projects/chip', // Absolute, real directory chosen by operator.
  workspaceId: 'a784ff42-e986-47b1-9140-b10f8ba68ca8',
  name: 'Chip project', token: process.env.DDS_WORKSPACE_TOKEN,
  plugins: [{plugin, artifactSha256: packedArtifactSha256, licenseText}],
  grants: ['workspace.read', 'workspace.write', 'backend.invoke'],
  backends: {'my-tool': createProcessBackend({
    executable: '/opt/my-tool/bin/json-adapter', args: ['--json'],
    cwd: '/home/me/projects/chip', env: {},
  })},
  notice: {id: 'my-host', version: '1', text: operatorNotice},
});
```

`packedArtifactSha256`, `licenseText` and `operatorNotice` are operator-provided
values. Use the actual packed plugin digest from the publishing workflow. The
example hashes only `plugin.mjs` bytes for a reproducible source demo; it is not
a full archive digest, signed publisher identity or malware verdict.

The process adapter uses fixed absolute executable, arguments and working
directory. It sends bounded JSON on stdin and expects bounded JSON on stdout.
There is no shell, request-controlled command line or inherited secret
environment. Supply only needed environment variables; a preinstalled tool may
need explicit `PATH` or runtime variables. stderr is bounded and not returned.
Cancellation kills the owned process group on Linux/WSL and uses Windows
`taskkill /PID <owned PID> /T /F` for the running owned tree. Stop waiting is
bounded; this is not an OS job-object sandbox, and detached escaped processes
require operator isolation. A tool adapter must translate its real tool's native
input/output; the SDK does not claim Verilator/KLayout integration by itself.

Open plugins use their chosen license/source metadata. Private plugins may use
`source.visibility:'closed'` with a `LicenseRef-...` and actual license text.
`private-manifest.json` is metadata guidance, not an implemented proprietary
plugin or legal permission to use someone else's work. Neither code publication
nor a public repository is required to configure a private user-host plugin.

## Client binding and file scope

```js
import {createWorkspaceClient} from '@altifigence/dds-plugin-sdk/workspace-client';
const client = createWorkspaceClient({url: 'https://workspace.example.com', token});
const hello = await client.connect();
// Product clients show the notice, workspace identity, licenses and artifact pins
// and obtain the user's approval before reads/writes/command execution.
const file = await client.readFile('rtl/top.sv');
await client.writeFile(file.path, file.content + '\n', file.revision);
client.dispose();
```

Root, capabilities, backend configuration, notice and artifact identity are
immutable within a generation; restart the host and obtain fresh approval when
changing any of them. Connect validates notice hashing and binds workspace UUID/generation. Every
later request carries that binding. A generation/workspace/authentication change
revokes it. Changed plugin metadata/pins revoke `listPlugins` or a mismatched
command request; reconnect and obtain fresh approval. This low-level SDK client
does not itself present or persist a consent UI. Server operator grants and
product approval are separate boundaries.

Paths are relative slash paths. Ordinary `.gitignore`, `.vscode/settings.json`
and `.github/workflows/build.yml` are supported. The shared
`isProtectedWorkspaceComponent` predicate rejects (case insensitive) `.git`,
`.hg`, `.svn`, `.ssh`, `.aws`, `.azure`, `.gnupg`, `.kube`, `.docker`, `.npmrc`,
`.pypirc`, `.netrc`, `_netrc`, `.git-credentials`, `.env`/`.env.*`, `.dds-write-*`,
`id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, `id_ecdsa_sk`, `id_ed25519_sk`, and
filenames ending in `.pem`, `.key`, `.p12` or `.pfx`. Traversal, invalid Unicode
or path characters, Windows device names (including superscript COM/LPT aliases
and `CONIN$`/`CONOUT$`), symlinks and multiply linked files are also denied.
Listing skips protected entries and hardlinks and never recursively walks them.
This explicit list is not a scanner for every possible secret. Trusted modules
and tools are still governed by their OS account.

Files must be valid UTF-8 and at most 262,144 bytes. New-file writes require
`expectedRevision:null`; existing writes require their SHA-256 revision. Server
mutations are serialized; stale writers through the same host conflict. External
editors do not participate in that lock: checks are best effort against them,
not cross-process atomic CAS or protection against a hostile OS user swapping
paths between checks. Temporary publication is atomic; timeout/disconnect may
happen after commit, so reread to establish the outcome. File rename never
overwrites and directory rename is unsupported. Directory removal is
nonrecursive. Read-only mode disables write and management even for a granted
plugin. Close disposes configured plugin and workspace ports.

Default timeout is 5 seconds, maximum 30 seconds. JSON data, request/reply bytes,
directory entries and pending requests are bounded. At most 16 request bodies
are received concurrently, before the 64-operation execution limit; excess
uploads get HTTP 429. The server accepts at most 128 connections and 128 requests
per socket. Completing or aborting an upload releases its slot. Clients cancel
unread rejected responses and stalled streams on deadline or cancellation.
Pass `signal` to cancel a
client operation. Remote cancellation is best effort and only affects that
configured principal's generation. See the protocol document for exact limits
and error codes.

These server and client protections require SDK 0.3.2 on their respective sides.
Updating a client leaves an older server's policy unchanged. See
[security upgrade guidance](../SECURITY.md) before moving an existing host.
