import {createNodeWorkspace} from '@altifigence/dds-plugin-sdk/workspace-node';
import {createNodeProjectWatcher} from '@altifigence/dds-plugin-sdk/project-watch-node';
import {parseProjectWatchOptions,parseProjectSnapshot,parseProjectWatchEvent,PROJECT_WATCH_LIMITS,type ProjectWatchEvent,type ProjectSnapshot} from '@altifigence/dds-plugin-sdk/project-watch';
const workspace=await createNodeWorkspace({root:'/operator/project'});
const watcher=await createNodeProjectWatcher({workspace,roots:['rtl'],fileSystem:'local'});
const options=parseProjectWatchOptions({root:'rtl',include:['**/*.sv']});
const snapshot:ProjectSnapshot=parseProjectSnapshot(await watcher.snapshot(options,{signal:new AbortController().signal}));
const files=snapshot.entries.map(entry=>({path:entry.path,revision:entry.revision}));void files;
for await(const event of watcher.watch(options)){
  const parsed:ProjectWatchEvent=parseProjectWatchEvent(event);void parsed;
  if(event.kind==='resync')console.log(event.reason);
  break;
}
const count:number=watcher.inspect().nativeHandles;void count;
const maximum:128=PROJECT_WATCH_LIMITS.nativeHandles;void maximum;
watcher.revoke();watcher.dispose();workspace.dispose();
// @ts-expect-error Explicit project root is required.
watcher.watch({});
// @ts-expect-error Network filesystem observation is not supported.
createNodeProjectWatcher({workspace,roots:['rtl'],fileSystem:'network'});
