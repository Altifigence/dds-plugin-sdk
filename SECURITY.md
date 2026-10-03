# Security

The supported security-fix line is the latest 0.1.x release. Report an SDK
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
