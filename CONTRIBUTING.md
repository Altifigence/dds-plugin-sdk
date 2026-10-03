# Contributing

Use Node 22 or 24. Clone the repository, run `npm ci`, then `npm run check`.
The check covers schemas, lifecycle tests, declarations, the example and a
consumer installed from the packed package. Runtime code must remain free of
dependencies and product-specific UI, engine and service imports.

Keep changes focused and include a test for observable contract or lifecycle
behavior. If a schema changes, run `npm run schemas:write` and update types,
runtime parsing and documentation together. Breaking wire changes require a
new protocol identity and migration guidance. Include benchmark results when
changing parsing or dispatch cost; `npm run benchmark` has a bounded fixture.

Open a pull request with the problem, resulting behavior and relevant checks.
Original contributions are provided under this repository's Apache-2.0 license.
Report security issues through the private channel described in SECURITY.md.
