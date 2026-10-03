# Package your own plugin

Copy this directory into a new project, install SDK 0.3.0 from its official
GitHub Release, and edit `plugin.json`, `plugin.mjs` and `disclosure.json`.
Set your own publisher, plugin ID, version, support URL and license.

```sh
npx --no-install dds-plugin validate .
npx --no-install dds-plugin pack . --out ./dist
```

The command creates `example-hello-publisher-1.0.0.tgz` and
`example-hello-publisher-1.0.0.tgz.release.json`. The latter contains the final
archive SHA-256 and file inventory. The archive includes only the files listed
in `dds-package.json`, that configuration file, and generated npm metadata.
It does not include this README or any unlisted source. The packer never imports
your plugin, executes scripts or publishes the archive.

The receiver first installs the SDK and then the plugin archive. An operator
can import the installed plugin explicitly and activate it in a test or workspace
host with no permissions. Run `greet` with `{name: 'Ada'}` to obtain a greeting.
Code supplied to a host runs with that process's operating-system authority.
Host APIs and permission grants do not create a JavaScript sandbox.

You can license code you own under proprietary terms. In that case supply your
actual license text and set `license` to a matching `LicenseRef-...` identifier
and `source.visibility` / disclosure `sourceVisibility` to `closed`. A JavaScript
entry module is still readable by the recipient; this label does not encrypt it.
See [publishing](../../docs/PUBLISHING.md) and [licensing](../../docs/LICENSING.md).
