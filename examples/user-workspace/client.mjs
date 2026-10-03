import {createWorkspaceClient} from '@altifigence/dds-plugin-sdk/workspace-client';
const client=createWorkspaceClient({url:process.argv[2]??'http://127.0.0.1:4777',token:process.env.DDS_WORKSPACE_TOKEN});
try{
  const hello=await client.connect();
  const plugin=hello.plugins.find(value=>value.manifest.id==='example.user-workspace');
  if(!plugin)throw new Error('Example plugin is not configured');
  console.log({workspace:hello.workspace,notice:hello.notice.text,license:plugin.manifest.license});
  // CLI developer smoke. Product clients must obtain approval before granting access/run.
  console.log(await client.listFiles());
  console.log(await client.runCommand(plugin.manifest.id,'inspect',{path:'design.sv'},plugin.artifactSha256));
  if(process.argv.includes('--edit')){
    console.log(await client.runCommand(plugin.manifest.id,'append-note',{path:'design.sv'},plugin.artifactSha256));
    console.log((await client.readFile('design.sv')).content);
  }
}finally{client.dispose();}
