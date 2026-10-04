import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {createPluginHost, parseManifest} from './index.mjs';
import * as inspector from 'node:inspector';
import {createDiagnosticSession,profileHost} from './diagnostics.mjs';

// Remain alive until the parent terminates this process tree after completion.
// This also lets the parent clean up children started during activation.
const keepAlive = setInterval(() => {}, 60_000);
process.once('disconnect', () => {clearInterval(keepAlive); process.exit(1);});
process.once('message', async ({directory, command, input, job, timeoutMs,profile=false,debug=false,debugWait=false}) => {
  const diagnostics=createDiagnosticSession({enabled:profile}),originalHost=createPluginHost({jobs:true}),host=profile?profileHost(originalHost,diagnostics):originalHost;let ok = false;
  try {
    if(debug){
      inspector.open(0,'127.0.0.1',false);
      if(process.connected)await new Promise((resolve,reject)=>process.send({type:'debug',url:inspector.url()},error=>error?reject(error):resolve()));
      if(debugWait)inspector.waitForDebugger();
    }
    const manifest = JSON.parse(await readFile(path.join(directory, 'plugin.json'), 'utf8'));
    const module = await import(pathToFileURL(path.join(directory, manifest.entry)).href);
    if (!isDeepStrictEqual(module.default?.manifest, parseManifest(manifest))) throw new Error('Entry manifest must match plugin.json');
    await host.activate(module.default);
    if (command && job) {
      let current = host.startCommandJob(manifest.id, command, input, {jobId: crypto.randomUUID(), timeoutMs}), after = 0;
      for (;;) {
        const page = host.getJobEvents(current.jobId, after); after = page.nextCursor;
        for (const event of page.events) process.stdout.write(`${JSON.stringify({type: 'job-event', event})}\n`);
        current = host.getJob(current.jobId);
        if (current.state !== 'running' && !page.hasMore) {process.stdout.write(`${JSON.stringify({type: 'job', result: current})}\n`); if (current.state !== 'succeeded') throw new Error('Development job did not succeed'); break;}
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    } else if (command) process.stdout.write(`${JSON.stringify({type: 'result', result: await host.executeCommand(manifest.id, command, input, {timeoutMs})})}\n`);
    else process.stdout.write(`${JSON.stringify({type: 'ready', pluginId: manifest.id, commands: host.listCommands()})}\n`);
    ok = true;
  } catch (failure) {process.stderr.write(`${failure instanceof Error ? failure.message.slice(0, 2_048) : 'Development execution failed'}\n`);}
  finally {
    host.dispose();
    await Promise.all([new Promise(resolve => process.stdout.write('', resolve)), new Promise(resolve => process.stderr.write('', resolve))]);
    const report=profile?diagnostics.snapshot():undefined;diagnostics.dispose();
    // The owning parent ends the inspector with this child, including attached or paused sessions.
    if (process.connected) process.send({type: 'complete', ok,...(profile?{profile:report}:{})});
  }
});
