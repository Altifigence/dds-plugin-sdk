import {createWorkspaceClient,createWorkspaceProject,parseWorkspaceProjectCapabilities,WORKSPACE_PROJECT_LIMITS,type WorkspaceProjectCapabilities,type WorkspaceProjectPoll} from '@altifigence/dds-plugin-sdk/workspace-client';
import {createWorkspaceServer} from '@altifigence/dds-plugin-sdk/workspace-node';
import {parseProjectWatchCapabilities,type ProjectWatchEvent} from '@altifigence/dds-plugin-sdk/project-watch';
const server=await createWorkspaceServer({root:'/operator/project',workspaceId:crypto.randomUUID(),token:'example-token-is-at-least-32-characters',notice:{id:'example',version:'1',text:'Local host'},projects:{roots:['rtl'],fileSystem:'local',leaseMs:30000}});
const client=createWorkspaceClient({url:server.url,token:'example-token-is-at-least-32-characters'});await client.connect();
const project=createWorkspaceProject(client),cap:WorkspaceProjectCapabilities=parseWorkspaceProjectCapabilities(await project.getProjectCapabilities());
if(cap.watch)parseProjectWatchCapabilities(cap.watch);
const options={root:'rtl',query:'module ',pageSize:16};
const page=await project.searchText(options);if(page.nextCursor)await project.releaseProjectQuery(page.nextCursor);
await project.searchFiles({root:'rtl',query:'**/*.sv',mode:'glob'});await project.listTree({root:'rtl'});await project.getProjectSnapshot({root:'rtl'});
for await(const event of project.watchProject({root:'rtl'},{timeoutMs:30000})){const update:ProjectWatchEvent=event;void update;break;}
const maximum:4=WORKSPACE_PROJECT_LIMITS.subscriptions;void maximum;const poll:WorkspaceProjectPoll|null=null;void poll;
// @ts-expect-error Explicit relative query root is required.
client.listTree({});
// @ts-expect-error Network filesystem project observation is unsupported.
createWorkspaceServer({workspaceId:crypto.randomUUID(),token:'token',notice:{id:'x',version:'1',text:'x'},projects:{roots:[''],fileSystem:'network'}});
project.dispose();client.dispose();server.revokeProjects();await server.close();
