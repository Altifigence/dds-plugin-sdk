import {createWorkspaceClient} from '@altifigence/dds-plugin-sdk/workspace-client';
import {applyWorkspaceEdit} from '@altifigence/dds-plugin-sdk/workspace-edits';
import {createNodeWorkspaceEditJournal} from '@altifigence/dds-plugin-sdk/workspace-edits-node';

process.once('message', async input => {
  let journal, client;
  const checkpoint = async phase => {process.send({phase, planId: input.preview.planId}); await new Promise(() => {});};
  try {
    client = createWorkspaceClient({url: input.url, token: input.token}); await client.connect();
    journal = await createNodeWorkspaceEditJournal({directory: input.directory, workspaceRoot: input.root, workspaceId: input.workspaceId});
    const journalPort = {...journal, async write(record) {
      await journal.write(record);
      if (input.pauseAt === 'intent' && record.steps[0].state === 'intent') await checkpoint('intent');
    }};
    const clientPort = {...client, async writeFile(...args) {
      const result = await client.writeFile(...args);
      if (input.pauseAt === 'applied') await checkpoint('applied');
      return result;
    }};
    const receipt = await applyWorkspaceEdit(clientPort, input.preview, {journal: journalPort, reviewed: {planId: input.preview.planId, digest: input.preview.digest}, authorize: () => true});
    process.send({unexpectedCompletion: receipt.status});
  } catch (error) {process.send({errorCode: error?.code ?? 'provider_failed'});}
  finally {client?.dispose(); await journal?.close(); process.disconnect();}
});
