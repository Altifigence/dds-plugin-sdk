import {createPluginHost, createLanguageResult, createLanguageRegistry} from '@altifigence/dds-plugin-sdk';
import {createWorkspaceClient} from '@altifigence/dds-plugin-sdk/workspace-client';
import {previewWorkspaceEdit, applyWorkspaceEdit, recoverWorkspaceEdit, createWorkspaceCompensation, parseWorkspaceEditReceipt, type WorkspaceEdit} from '@altifigence/dds-plugin-sdk/workspace-edits';
import {createNodeWorkspaceEditJournal} from '@altifigence/dds-plugin-sdk/workspace-edits-node';
const client = createWorkspaceClient({url: 'http://127.0.0.1:1234', token: 'operator-selected-token-0123456789'});
const journal = await createNodeWorkspaceEditJournal({directory: '/operator/journal', workspaceRoot: '/operator/project', workspaceId: crypto.randomUUID()});
const proposal: WorkspaceEdit = {formatVersion: 1, id: crypto.randomUUID(), title: 'Create a file', changes: [{kind: 'create', path: 'new.txt', content: 'new'}]};
const preview = await previewWorkspaceEdit(client, proposal);
const applied = await applyWorkspaceEdit(client, preview, {journal, reviewed: {planId: preview.planId, digest: preview.digest}, authorize(request, {signal}) {signal?.throwIfAborted(); return request.requiredCapabilities.includes('write');}});
const recovery = parseWorkspaceEditReceipt(await recoverWorkspaceEdit(client, journal, preview.planId));
const inverse: WorkspaceEdit | null = createWorkspaceCompensation(preview, recovery, {id: crypto.randomUUID()});
const host = createPluginHost(), prep = await host.requestLanguage('prepare-rename', {position: {line: 0, character: 0}});
const placeholder: string | undefined = prep.data?.placeholder;
const renamed = await host.requestLanguage('rename', {position: {line: 0, character: 0}, newName: 'name'});
const suggested: WorkspaceEdit | null = renamed.data;
const registry = createLanguageRegistry('rename'); registry.register('typed', {languages: ['plain']}, {provide: request => createLanguageResult(request, proposal)});
// @ts-expect-error Rename needs a new name.
host.requestLanguage('rename', {position: {line: 0, character: 0}});
// @ts-expect-error Prepare rename does not accept a new name.
host.requestLanguage('prepare-rename', {position: {line: 0, character: 0}, newName: 'name'});
// @ts-expect-error Writes need both current authorization and the reviewed digest.
applyWorkspaceEdit(client, preview, {journal});
// @ts-expect-error Existing-file edits require a pinned revision.
const invalid: WorkspaceEdit = {formatVersion: 1, id: crypto.randomUUID(), title: 'Edit', changes: [{kind: 'delete', path: 'old.txt'}]};
// @ts-expect-error Preview file snapshots are immutable.
preview.steps[0]!.before[0]!.state!.content = 'changed';
void applied; void inverse; void placeholder; void suggested; void invalid; await journal.close();
