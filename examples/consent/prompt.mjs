import {createInterface} from 'node:readline/promises';
import {stdin, stdout} from 'node:process';
import {createNotice, createPermissionGrant, isPermissionGranted, revokeConsentReceipt} from '@altifigence/dds-plugin-sdk/consent';

// Local demonstration only: no plugin execution, file writes, authentication or upload.
const manifest = {
  manifestVersion: 2, id: 'consent-example', name: 'Local consent example', publisher: 'example',
  version: '1.0.0', protocolVersion: 1, entry: './plugin.mjs', runtime: 'workspace', capabilities: ['commands'],
  permissions: ['workspace.read'], supportedHosts: ['workspace-host'], license: 'Apache-2.0',
  source: {visibility: 'open', licenseFile: 'LICENSE'},
};
const notice = await createNotice({
  id: 'selected-workspace-read', version: '1.0.0', locale: 'en', purpose: 'Read one selected demonstration workspace',
  text: 'Allow consent-example 1.0.0 to read the selected local demonstration workspace for this session. No workspace write, backend invocation or network access is requested. This record expires after five minutes. You can type revoke below to record revocation. This example never executes a plugin or sends data.',
});
console.log(`${notice.text}\n\nRequested permission: workspace.read\nDeclared license: Apache-2.0 (no SDK license click required)\nNotice text SHA-256: ${notice.contentSha256}\n`);

const terminal = createInterface({input: stdin, output: stdout});
try {
  const choice = await terminal.question('Type allow to record permission; Enter or any other answer denies: ');
  const now = new Date();
  const receipt = await createPermissionGrant({
    manifest, artifactSha256: 'a'.repeat(64), // Synthetic identity, not a real package verification receipt.
    workspaceId: '00000000-0000-4000-8000-000000000001', generation: crypto.randomUUID(),
    permissions: choice === 'allow' ? ['workspace.read'] : [], decision: choice === 'allow' ? 'granted' : 'denied',
    notice, receiptId: crypto.randomUUID(), actorRef: 'local-demonstration-user',
    occurredAt: now.toISOString(), expiresAt: new Date(now.getTime() + 300_000).toISOString(),
    host: {id: 'workspace-host', version: '0.2.0', protocolVersion: 1},
  });
  const expected = {
    pluginId: receipt.plugin.id, pluginVersion: receipt.plugin.version, publisher: receipt.plugin.publisher,
    artifactSha256: receipt.plugin.artifactSha256, manifestSha256: receipt.plugin.manifestSha256,
    workspaceId: receipt.scope.workspaceId, generation: receipt.scope.generation,
    hostId: receipt.host.id, hostVersion: receipt.host.version, noticeSha256: notice.sha256,
  };
  console.log(`\nUnsigned local record:\n${JSON.stringify(receipt, null, 2)}`);
  console.log(`Permission evaluation: ${await isPermissionGranted(receipt, expected, 'workspace.read', new Date().toISOString())}`);
  if (receipt.decision === 'granted') {
    const change = await terminal.question('Type revoke to record revocation; Enter leaves the local record unchanged: ');
    if (change === 'revoke') {
      const revocation = await revokeConsentReceipt(receipt, {receiptId: crypto.randomUUID(), actorRef: receipt.actorRef, occurredAt: new Date().toISOString()});
      console.log(`\nSeparate revocation:\n${JSON.stringify(revocation, null, 2)}`);
      console.log(`Permission after revocation: ${await isPermissionGranted(receipt, expected, 'workspace.read', new Date().toISOString(), [revocation])}`);
    }
  }
} finally { terminal.close(); }
