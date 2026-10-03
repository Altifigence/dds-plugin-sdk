# Public SDK scope

This is the external developer SDK for Digital Design Studio. The published code
is intentionally available under Apache-2.0 so developers can read it, build
independent plugins and implement compatible hosts.

## Included

- Plugin manifests, typed public contracts, validators and JSON schemas.
- Diagnostics and command lifecycle helpers, a trusted development host, themes,
  and a user-operated workspace server/client.
- File allowlist packaging, disclosure/consent helpers, tests and examples.
- A small synthetic HDL example, not a customer project or PDK.

## Outside this repository

The DDS application and production host adapters, simulation engines, private UI,
account/billing services, deployment configuration, credentials and signing
authority are not supplied here. Protocol fields and permission names describe
interoperability; they do not grant access to a private service or its implementation.

The separately published tool integrations have their own selected source
inventories and licenses. Their publication is not a license grant for other DDS
files. See the [integration guide](https://docs.altifigence.com/products/digital-design-studio/plugins/).

## Review a release

[PUBLIC_SURFACE.json](../PUBLIC_SURFACE.json) lists every allowed SDK package file.
CI checks the actual npm package inventory, tracked source, private implementation
references and recognizable credential patterns. A new package file requires an
explicit inventory change. `npm run pack:check` tests an independently installed
package afterward.

These checks catch specific mistakes. They do not determine whether arbitrary
code is confidential, exhaustively detect secrets, certify licensing or scan
plugins for malware. Imports from another project still need a publication and
rights review. Never copy a private checkout here or publish private material
merely because an automated check passes.
