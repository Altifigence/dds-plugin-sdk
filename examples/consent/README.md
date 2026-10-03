# Explicit local permission choice

Run `node examples/consent/prompt.mjs` from the SDK checkout with Node.js 22 or 24.
The example preserves and hashes the exact displayed notice, shows the declared
plugin license separately, and requires the literal answer `allow`. Enter or any
other answer records a denial. An allowed choice offers a separate `revoke`
action and evaluates the resulting invalidation.

The package digest is synthetic and clearly labeled. This example prints an
unsigned local record; it runs no plugin, uploads no data and saves no receipt.
A real host must obtain the actual artifact digest, control identity/time and
receipt storage, supply all revocations, and enforce its permission checks.
Notice acknowledgement and optional personal-data consent are separate API
records; no broad agreement or privacy choice is inferred here.

For a real `backend.invoke` grant, keep the backend configuration immutable for
its workspace generation. Changing a command, endpoint or other backend settings
requires restarting the server with a fresh generation and obtaining fresh host
approval. A generic invoke grant must not silently follow a changed backend.
