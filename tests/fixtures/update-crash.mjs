import {createNodeUpdateJournal} from '../../src/updates-node.mjs';
const journal=await createNodeUpdateJournal({directory:process.argv[2],workspaceRoot:process.argv[3]});
await journal.compareAndSwap(0,{schemaVersion:1,revision:1,activeSha256:'a'.repeat(64),settingsSha256:'b'.repeat(64),phase:'preparing',plan:null,disposition:'fixture-before-activation'});
process.stdout.write('ready\n');
setInterval(()=>{},1000);
