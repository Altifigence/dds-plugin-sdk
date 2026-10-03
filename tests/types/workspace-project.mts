import {createWorkspaceClient, createWorkspaceProject, applyTextEdits, type WorkspaceEditSession, type TextEdit} from '@altifigence/dds-plugin-sdk/workspace-client';
const client = createWorkspaceClient({url: 'http://127.0.0.1:8787', token: 'operator-provided-fixture-token-123456'});
await client.connect();
const project = createWorkspaceProject(client);
const session: WorkspaceEditSession = await project.openFile('design.sv');
const edits: readonly TextEdit[] = [{range: {start: {line: 0, character: 0}, end: {line: 0, character: 0}}, text: '// note\n'}];
await session.saveEdits(edits, {timeoutMs: 1000});
const content: string = session.snapshot.content;
const revision: string = session.snapshot.revision;
const updated: string = applyTextEdits(content, edits);
// @ts-expect-error Snapshots cannot be overwritten to bypass CAS.
session.snapshot.revision = 'new';
// @ts-expect-error A text edit needs a range.
session.saveEdits([{text: 'x'}]);
session.dispose(); project.dispose(); client.dispose();
void revision; void updated;
