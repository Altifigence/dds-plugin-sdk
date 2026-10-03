# User workspace protocol 1

The user runs the workspace server, plugin code and preinstalled tools in their
own WSL, container or remote environment. DDS is a client. This API does not
install packages, accept module paths, run shell strings or transfer DDS account
credentials. Trusted plugins execute in the server process; this is not an OS
sandbox. The operator chooses the workspace root, plugins, tools and grants.

## Transport and binding

Send `POST /dds/workspace/v1` with `Content-Type: application/json` and
`Authorization: Bearer <operator-token>`. Tokens have at least 32 characters;
there is no default token. Never put tokens in URLs or logs. The server binds
`127.0.0.1` by default. Use an operator-managed TLS reverse proxy for remote
deployment. Clients allow HTTPS or strictly loopback HTTP and never redirects.
CORS is denied unless the operator configures exact origins; `Origin: null` is
always rejected. Native clients may omit Origin.

```json
{"version":1,"requestId":"unique-request","method":"hello","params":{}}
```

Only `hello` may omit binding. Every other method includes `workspaceId` and
`generation` matching the authenticated server's hello result. The workspace ID
is an operator-configured UUID. Generation is a new random UUID on each server
start. Reconnect and obtain consent again after identity, generation, artifacts
or notice changes. Request IDs are bounded strings and unique among pending
requests. One token is one configured principal; request parameters cannot
increase its permissions.

Workspace root, capabilities, backend configuration, notice and plugin artifact
identity are immutable within a generation. Restart with a new generation and
obtain fresh approval when any changes. The example has no API for changing
those settings. An externally supplied host that changes plugin metadata is
rejected with `generation_mismatch`; it must be restarted.

```json
{"version":1,"requestId":"read-1","method":"fs.read","workspaceId":"UUID","generation":"UUID","params":{"path":"rtl/top.sv"}}
```

Replies echo request identity:

```json
{"version":1,"requestId":"read-1","ok":true,"result":{"path":"rtl/top.sv","content":"module top; endmodule\n","revision":"SHA256"}}
```

```json
{"version":1,"requestId":"read-1","ok":false,"error":{"code":"conflict","message":"The file revision changed"}}
```

Errors never include host roots, bearer tokens, tool stderr or plugin stacks.
HTTP 401/403 rejects authentication/origin; authenticated operation failures use
the error envelope. Clients validate successful envelopes and method results.

## Methods

| Method | Parameters | Result |
| --- | --- | --- |
| `hello` | `{}` | Description below |
| `fs.list` | `{path: ''}` or a relative directory | `{entries: [{path,name,kind:'file'\|'directory',size?,revision?}]}` |
| `fs.read` | `{path}` | `{path,content,revision}` |
| `fs.write` | `{path,content,expectedRevision}` | `{path,revision}` |
| `fs.mkdir` | `{path}` | `{path}` |
| `fs.rename` | `{path,newPath,expectedRevision?}` | `{path,newPath}` |
| `fs.remove` | `{path,expectedRevision?}` | `{path}` |
| `plugins.list` | `{}` | `{plugins: [...]}` |
| `commands.run` | `{pluginId,commandId,input,artifactSha256}` | Bounded JSON command result |
| `request.cancel` | `{requestId: 'target-request'}` | `{cancelled: boolean}` |

Paths are relative POSIX paths. Absolute paths, backslashes, traversal, symlinks,
protected components and invalid/control characters are rejected. Listings are
sorted and bounded, never recurse automatically, and never expose an absolute
host root. Ordinary `.gitignore`, `.vscode/settings.json` and `.github/workflows`
are supported. The exported `isProtectedWorkspaceComponent` predicate rejects
case-insensitive `.git`, `.hg`, `.svn`, `.ssh`, `.aws`, `.azure`, `.npmrc`, `.pypirc`,
`.env`/`.env.*`, `.dds-write-*`, `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, and
filenames ending in `.pem`, `.key`, `.p12` or `.pfx`. Listings skip those entries;
this explicit exclusion list is not a scanner for every secret. Trusted plugin code and
tools retain their OS user's ambient access.

`revision` is the SHA-256 of exact UTF-8 file bytes. `expectedRevision: null`
means create a new absent file only. Updating an existing file requires its
revision. Writes serialize within this server, check CAS and publish a flushed
temporary file atomically. They never overwrite after a failed CAS check.
External editors are outside this server's transaction lock: do not promise
cross-process atomic CAS or protection from hostile OS path swaps between checks.
Rename supports regular files only and never overwrites a destination. Remove never
recursively deletes a directory. Read-only servers advertise `write:false` and
`manage:false`; unsupported operations fail closed.

The hello result is:

```json
{
  "hostId":"workspace-host","hostVersion":"0.2.0","protocolVersion":1,
  "workspace":{"id":"UUID","name":"My workspace","generation":"UUID"},
  "capabilities":{"read":true,"write":true,"commands":true,"manage":true},
  "plugins":[{"manifest":{},"artifactSha256":"64 lowercase hex","commands":[],"licenseText":"Optional publisher license"}],
  "notice":{"id":"user-workspace-notice","version":"1","sha256":"64 lowercase hex","text":"Operator notice"}
}
```

Plugin metadata comes from configured, activated plugins. Command metadata uses
`{pluginId,id,title,description?,parameters?:[{name,label,type,required,choices?}]}`.
`commands.run` must present the exact advertised plugin artifact hash. The hash
identifies bytes the operator configured; it is not proof of publisher identity
or a malware assessment. Packed artifact hashes should cover the actual plugin
archive. A source example may hash its single module, clearly labeled as such.
Private plugins may advertise a proprietary license and license text while
their source stays in the user host; source publication is not required by this
protocol. The operator and publisher remain responsible for rights and notices.

Manifests are validated using the SDK manifest-v2 contract, `runtime:'workspace'`
and `supportedHosts:['workspace-host', ...]`. Optional `parameters` preserve core
semantics: omission accepts arbitrary bounded JSON; explicit `[]` accepts only
an empty object. When present there are at most 32 parameters with unique names,
and string-only `choices` for string parameters. Titles and parameter names are
at most 128 characters. `plugins.list` returns the same fully validated metadata;
changed metadata/artifact pins require client revocation and fresh approval.

Requests and replies are limited to 1,600,000 UTF-8 JSON bytes. File content is
limited to 262,144 UTF-8 bytes and must be valid UTF-8. JSON command input/output
is limited to 262,144 bytes, depth 16 and 10,000 nodes. The default request budget
is five seconds, maximum thirty seconds; pending requests and files in a listing
are bounded. Disconnect and cancellation abort the owned operation. Cancellation
is scoped to the authenticated principal and generation and cannot cancel an
unrelated server request. A timeout or disconnect does not prove that an already
committed file write did not happen; reread before deciding what to do next.

Stable codes include `invalid_request`, `authentication_required`,
`permission_denied`, `workspace_mismatch`, `generation_mismatch`, `not_found`,
`conflict`, `unsafe_path`, `budget_exceeded`, `cancelled`, `disposed`,
`plugin_mismatch`, `provider_failed`, `unsupported`, `unavailable` and
`transport_failed`. Client request/reply identity mismatches fail closed.
