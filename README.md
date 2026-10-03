# DDS Plugin SDK

Build diagnostics plugins for Digital Design Studio with a small ESM package,
TypeScript declarations, versioned JSON contracts and a working local test host.
The SDK has **zero runtime dependencies**.

Version **0.1.0** supports plugin development with the included test host on Node
22 and 24. DDS Desktop and Cloud do not yet load these plugins.

## Run your first plugin

```sh
git clone https://github.com/Altifigence/dds-plugin-sdk.git
cd dds-plugin-sdk
npm ci
npm test
npm run example
```

The [Hello Diagnostics plugin](examples/hello-diagnostics/plugin.mjs) finds a
`TODO` in a supplied text document. It uses no external tool or service.

```text
Hello Diagnostics: 1 diagnostic
info 2:1 Resolve this TODO before sharing the document.
```

Edit the provider in `examples/hello-diagnostics/plugin.mjs`, then rerun the
example. [The runner](examples/hello-diagnostics/run.mjs) shows how to activate
your plugin, supply a snapshot, request diagnostics and dispose the host.

## Use the released package in your project

Create an ESM project and install the exact release archive:

```sh
mkdir my-dds-plugin
cd my-dds-plugin
npm init -y
npm pkg set type=module
npm install https://github.com/Altifigence/dds-plugin-sdk/releases/download/v0.1.0/altifigence-dds-plugin-sdk-0.1.0.tgz
```

Copy the example's `plugin.mjs` and `run.mjs` into this directory, then run:

```sh
node run.mjs
```

The package uses native JavaScript modules; no build step is required. TypeScript
users can import the same package with `module` and `moduleResolution` set to
`NodeNext`. The tarball is distributed through [GitHub Releases](https://github.com/Altifigence/dds-plugin-sdk/releases),
and the install command includes the release URL rather than an npm registry lookup.

## API and tests

| Import | Use |
| --- | --- |
| `@altifigence/dds-plugin-sdk` | `definePlugin`, `createDiagnosticsResult`, bounded parsers, types and lifecycle helpers |
| `@altifigence/dds-plugin-sdk/testing` | `createTestHost` for trusted local plugins |
| `@altifigence/dds-plugin-sdk/schemas` | JSON Schema objects, loaded separately from the core API |

[API reference](docs/api.md) explains the manifest, permissions, requests,
ranges, cancellation and error codes. [Write a plugin test](docs/testing.md)
with Node's built-in test runner. [Performance](docs/performance.md) describes
the repeatable synthetic benchmark.

```sh
npm run check       # schemas, runtime tests, types, example and packed consumer
npm run pack:check  # install the tarball in a separate temporary project
npm run benchmark  # bounded local measurements
```

The developer test host executes trusted modules in the same process. Production
hosts must provide their own code isolation and permission enforcement. The
[host contract](docs/host-contract.md) gives the adapter requirements.

## Contribute

See [CONTRIBUTING](CONTRIBUTING.md), [SECURITY](SECURITY.md) and
[CHANGELOG](CHANGELOG.md). The SDK and included examples are licensed under
[Apache-2.0](LICENSE).
