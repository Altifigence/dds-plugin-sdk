# Security

The supported security-fix line is the latest 0.2.x release. Report an SDK
validation, lifecycle or permission-boundary vulnerability through
[private vulnerability reporting](https://github.com/Altifigence/dds-plugin-sdk/security/advisories/new).
If the form is unavailable, ask maintainers for a private contact without posting
exploit details or project data in an issue.

Include the SDK version, a minimal synthetic reproducer, expected behavior and
impact. Omit credentials, customer source and private filesystem paths.

The local developer host runs trusted plugins in the same process. It is not a
security sandbox and cannot stop a plugin's synchronous loop or ambient Node
access. A signed archive or successful test does not establish plugin safety.
Production adapters are responsible for isolation, grants, quotas and revocation.

The user-owned workspace server requires an explicit token and root. It exposes
operator-selected plugins and fixed backend handlers. Use HTTPS for remote
connections, keep tokens out of URLs and logs, and restrict the operating-system
account/container running the host. The sample host does not authenticate a
publisher, scan code for malware or prevent a trusted plugin from using ambient
process privileges. File checks protect the API path; they do not isolate the
host from a hostile administrator or another process that can modify the root.

Packaging reads only explicitly listed files and blocks common private key and
configuration names plus recognizable key/token content. Public package inventory
and source checks are described in [Public scope](docs/PUBLIC_SCOPE.md).
These are not complete secret scanners. Inspect the archive
before publishing. Consent receipts are unsigned local records; consumers must
protect storage, verify the current identity and implement revocation themselves.
