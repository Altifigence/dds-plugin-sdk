# Workflows and incremental cache

SDK 1.2 adds optional Node-only `workflows`, `workflows-node`, `workflow-cache` and
`workflow-cache-node` exports. They compose public command jobs in an operator-owned
host. They do not provide a DDS Cloud scheduler or run automatically after restart.

Run the complete example from a checkout with `npm run example:workflows`, or from
an installed SDK:

```sh
node node_modules/@altifigence/dds-plugin-sdk/examples/workflows/run.mjs
```

The example creates disposable workspaces and stores. It runs existing PluginHost
command jobs, reuses three cache hits, changes one input file, executes only that
step and its dependent step, and blocks a dependent step after failure. It then
kills its own child after a durable checkpoint, reads an interrupted attempt and
explicitly retries one unfinished step. Its JSON receipt reports counts, timings,
cache metrics and stored bytes. Timings describe the local fixture, not a service SLA.

## Review, execute and resume

`prepareWorkflowPlan(definition, commands)` returns an immutable plan and SHA-256.
Definitions contain a workspace/security scope, unique step IDs, registered command
IDs, explicit `needs`, input bindings and grants. Each binding is either `{value}`
or `{step, path}`. Output bindings name a direct dependency and a required object
path; source and target data schemas must match exactly. Cycles, missing commands,
duplicate IDs, missing required inputs and schema mismatches fail before execution.
Inputs use the closed [data schema subset](DATA_SCHEMAS.md). Secret-reference
schemas are unsupported in persisted workflows; the host must also exclude raw
secrets from ordinary values.

```js
import {prepareWorkflowPlan, createWorkflowRunner} from '@altifigence/dds-plugin-sdk/workflows';

const plan = prepareWorkflowPlan(definition, registeredCommands);
// Present plan.definition, plan.commands and plan.sha256 to the operator.
const runner = createWorkflowRunner({
  commands: registeredCommands, store, execute,
  authorize: context => hostPolicy.allows(context),
});
const record = await runner.run(plan, {
  approval: {approved: true, planSha256: reviewedSha256}, signal,
});
```

`execute(step, command, input, context)` is a trusted host port. It receives a new
job ID, attempt ID and cancellation signal, and returns `{output, artifacts?}`.
`createCommandJobExecutor({resolveHost})` connects this port to an existing
PluginHost. The resolver must return `{host, scope, grants, pluginSha256}` for the
reviewed step. It must choose an isolated host whose effective grants exactly match
the returned list; SDK metadata cannot inspect or confine arbitrary host code.
Step grants are never merged with another step's grants. Current authorization is
checked before execution, after results and before retained-result reuse.

`continue` lets independent branches complete and marks descendants of failure as
`blocked`. `fail-fast` cancels remaining work. Every checkpoint includes the plan,
input and output digests, parent attempt/job, step job IDs, artifact references,
timestamps, cache evidence and failure codes. Referenced job artifacts retain their
own retention and permission rules; a workflow record does not extend their life.
A host handler that ignores cancellation remains counted as unsettled, and another
run is refused until it settles. Arbitrary host ports must honor cancellation.

`runner.recover(attemptId)` reads the stored checkpoint and returns pending/running
work as `interrupted`. It never calls the executor. Resume passes that exact
checkpoint as `previous` and adds `previousAttemptId` to a new digest-bound
approval. The result has a new attempt ID. Successful unexpired steps with matching
inputs can be retained; `retrySteps` explicitly reruns selected steps and their
descendants, independent of declaration order. Expired partial output requires an
explicit retry selection. Changed plan, schema, grants or plugin pins need a new
plan rather than resuming an old checkpoint.

## Durable ownership and retention

`createNodeWorkflowStore({directory, workspaceRoot, scope})` uses a single-writer
lock and a scope/workspace identity marker. Both existing directories must be real,
disjoint directories. Records use checksummed envelopes, atomic replacement and
compare-and-swap revisions. Windows does not report directory fsync support;
this is process-restart recovery, not a power-loss durability guarantee.

Open normally after a clean `close()`. After a known crash,
`recoverStaleLock: true` permits recovery only when the recorded same-machine PID
is proven dead. Live or uncertain owners remain conflicts. PID reuse may require
operator intervention. A leftover recovery lock is preserved for inspection.

The default `cleanup()` removes only recognized bounded corrupt records and
unfinished temporary writes. Unknown entries and links are preserved. Explicit
`cleanup({expiredBefore: Date.now()})` also removes expired terminal records;
pending/running records are retained for recovery. It returns removed and preserved
filenames. The store stops at its quota and does not delete workspace source files.
The caller owns cleanup and rotation of memory stores and closed store directories.

## Cache eligibility and invalidation

Use `fingerprintWorkflowInputs` with actual file bytes and an explicit policy:
`optIn`, `deterministic`, `declaredInputsComplete`, `secretDependent`. It hashes SDK
version, workspace/security scope, command, plugin/tool digests, command schema,
settings, input, declared environment names/values, grants and each file's content.
It does not use mtime as a content identity. Determinism and completeness are host
attestations; the SDK cannot discover hidden process inputs or detect all secrets.

Unknown/incomplete inputs, nondeterminism, secret dependence, undeclared/missing
environment and secret-reference inputs return an ineligible fingerprint with
reasons. They still execute through `cache.run` but return `bypass` and are not
retained. Secret-reference results are also not stored. Never opt in commands with
external side effects or unrepresented dependencies.

`createWorkflowCache({authorize, store?})` rechecks current authorization on lookup,
fill, after fill, hits and return. Hits verify value digest, scope, grants and TTL.
Concurrent eligible misses share a fill; cancelling one waiter does not cancel
other waiters. A fill with no waiters is cancelled. TTL and LRU bound retained
results, and `cleanup()` handles expiry and owned-store recovery. Corrupt entries
are misses. A storage write failure returns a computed value with a distinct
reason; it is not reported as a successful retained cache write.

The workflow executor can return `cache: {state, key, reason}` with the cached
output. `hit` and `shared` records have no fresh job ID and cannot claim mutable
job artifacts. The example applies cache lookup only after dependencies succeed.
Changed leaf content invalidates that leaf; changed output changes its dependents'
input hashes. A failed dependency blocks its descendants before cache lookup.

| Resource | Maximum |
| --- | --- |
| Workflow steps / concurrency | 64 / 8 |
| Plan / record / aggregate outputs | 1 MiB / 2 MiB / 1 MiB |
| Individual JSON result | 64 KiB |
| Workflow / step deadline | 10 minutes; step cannot exceed workflow |
| Partial-result retention | 24 hours |
| Durable workflow records / storage | 64 / 32 MiB |
| Fingerprinted files / each / total | 64 / 4 MiB / 16 MiB |
| Cache entries / retained value bytes | 512 / 16 MiB |
| Concurrent cache fills / fill timeout | 8 / 60 seconds |

The Node cache store additionally bounds envelope storage to 64 MiB. Schema files
cover definitions, plans, records, fingerprints and cache entries; runtime parsers
also enforce cross-field, byte-budget and hash constraints. See [tool streams](TOOL_STREAMS.md)
for registered tool execution and [LSP](LSP.md) for language-server integration.
