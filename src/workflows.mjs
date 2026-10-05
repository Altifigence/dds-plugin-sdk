import {randomUUID} from 'node:crypto';
import {parseDataSchema, validateDataValue} from './data-schema.mjs';
import {parseJobSnapshot, parseJobArtifact} from './jobs.mjs';
import {canonical, clone, digest, fail, fields, sha, string, identifier, integer, scope, strings, immutable, jsonCopy, aborted, deadline, interruptible, authorized, errorCode, pause} from './workflow-internals.mjs';

export const WORKFLOW_LIMITS = Object.freeze({steps:64, concurrency:8, planBytes:1_048_576, recordBytes:2_097_152, valueBytes:65_536, outputBytes:1_048_576, timeoutMs:600_000, retentionMs:86_400_000, records:64});
const secret = node => node.format === 'dds-secret-reference' || Object.values(node.properties ?? {}).some(secret) || !!node.items && secret(node.items);
function schema(value) {const result = parseDataSchema(value); if (secret(result.schema)) fail('UNSUPPORTED', 'Workflow persistence does not accept secret-reference fields'); return result;}
function command(value) {
  fields(value, ['id','pluginId','pluginSha256','inputSchema','outputSchema','grants']); identifier(value.id); identifier(value.pluginId); sha(value.pluginSha256); strings(value.grants);
  schema(value.inputSchema); schema(value.outputSchema);
  if (value.inputSchema.schema.type !== 'object' || value.inputSchema.schema.format) fail('INVALID', 'Workflow command inputs must be closed objects');
  return value;
}
export function parseWorkflowDefinition(input) {
  const value = jsonCopy(input, WORKFLOW_LIMITS.planBytes);
  fields(value, ['schemaVersion','id','scope','steps','policy','concurrency','timeoutMs','stepTimeoutMs','retentionMs']);
  if (value.schemaVersion !== 1 || !['fail-fast','continue'].includes(value.policy)) fail('INVALID', 'Unsupported workflow contract');
  identifier(value.id); scope(value.scope); integer(value.concurrency,1,WORKFLOW_LIMITS.concurrency); integer(value.timeoutMs,1,WORKFLOW_LIMITS.timeoutMs); integer(value.stepTimeoutMs,1,value.timeoutMs); integer(value.retentionMs,1,WORKFLOW_LIMITS.retentionMs);
  if (!Array.isArray(value.steps) || !value.steps.length || value.steps.length > WORKFLOW_LIMITS.steps) fail('LIMIT', 'Workflow step limit');
  const ids = new Set();
  for (const step of value.steps) {
    fields(step, ['id','commandId','needs','input','grants']); identifier(step.id); identifier(step.commandId); strings(step.needs); strings(step.grants);
    if (ids.has(step.id)) fail('INVALID', 'Duplicate workflow step'); ids.add(step.id);
    if (!step.input || typeof step.input !== 'object' || Array.isArray(step.input)) fail('INVALID', 'Invalid bindings');
    for (const [name,binding] of Object.entries(step.input)) {
      identifier(name);
      if (Object.hasOwn(binding ?? {},'value')) {fields(binding,['value']); jsonCopy(binding.value);}
      else {fields(binding,['step','path']); identifier(binding.step); if (!Array.isArray(binding.path) || binding.path.length > 8) fail('INVALID','Invalid output path'); binding.path.forEach(identifier);}
    }
  }
  const visiting = new Set(), visited = new Set(), byId = new Map(value.steps.map(s => [s.id,s]));
  function visit(id) {if (visiting.has(id)) fail('INVALID','Workflow cycle'); if (visited.has(id)) return; const step = byId.get(id); if (!step) fail('INVALID','Missing dependency'); visiting.add(id); step.needs.forEach(visit); visiting.delete(id); visited.add(id);}
  value.steps.forEach(s => visit(s.id)); return value;
}
export function prepareWorkflowPlan(input, definitions) {
  const definition = parseWorkflowDefinition(input), commands = jsonCopy(definitions, WORKFLOW_LIMITS.planBytes);
  if (!Array.isArray(commands) || commands.length > WORKFLOW_LIMITS.steps) fail('LIMIT','Command limit'); commands.forEach(command);
  const byCommand = new Map(commands.map(c => [c.id,c])); if (byCommand.size !== commands.length) fail('INVALID','Duplicate command');
  const byStep = new Map(definition.steps.map(s => [s.id,s]));
  const used = [...new Set(definition.steps.map(s => s.commandId))].sort().map(id => {const c = byCommand.get(id); if (!c) fail('UNSUPPORTED','Command not registered'); return c;});
  for (const step of definition.steps) {
    const cmd = byCommand.get(step.commandId), shape = cmd.inputSchema.schema;
    if (cmd.grants.some(g => !step.grants.includes(g))) fail('DENIED','Step did not explicitly grant command requirements');
    for (const required of shape.required ?? []) if (!Object.hasOwn(step.input, required)) fail('INVALID','Missing input binding');
    for (const [name,binding] of Object.entries(step.input)) {
      const target = shape.properties[name]; if (!target) fail('INVALID','Unknown command input');
      if (Object.hasOwn(binding,'value')) validateDataValue({schemaVersion:1,schema:target},binding.value);
      else {
        if (!step.needs.includes(binding.step)) fail('INVALID','Output binding must name an explicit dependency');
        let source = byCommand.get(byStep.get(binding.step)?.commandId)?.outputSchema.schema;
        for (const component of binding.path) {if (!source || source.type !== 'object' || !source.required?.includes(component)) fail('INVALID','Output path must be required'); source = source.properties[component];}
        // Conservative assignability: constraints, including nested required fields, must match exactly.
        if (!source || canonical(source) !== canonical(target)) fail('INVALID','Input and output schemas differ');
      }
    }
  }
  const body = {schemaVersion:1,definition,commands:used}; return immutable({...body,sha256:digest(canonical(body,WORKFLOW_LIMITS.planBytes))});
}
const states = ['pending','running','succeeded','failed','cancelled','timed_out','blocked','interrupted'];
function cacheEvidence(value){fields(value,['state','key','reason']);if(!['hit','miss','shared','bypass'].includes(value.state))fail('INVALID','Invalid cache evidence');sha(value.key);string(value.reason,'cache reason',256);return value;}
export function parseWorkflowRecord(input) {
  const value = jsonCopy(input, WORKFLOW_LIMITS.recordBytes);
  fields(value,['schemaVersion','workflowId','attemptId','parentAttemptId','parentJobId','planSha256','scope','revision','state','startedAt','updatedAt','expiresAt','steps']);
  if (value.schemaVersion !== 1 || !states.includes(value.state)) fail('INVALID','Invalid workflow state');
  identifier(value.workflowId); identifier(value.attemptId); if (value.parentAttemptId !== null) identifier(value.parentAttemptId); if (value.parentJobId !== null) identifier(value.parentJobId); sha(value.planSha256); scope(value.scope);
  integer(value.revision,1,Number.MAX_SAFE_INTEGER); for (const name of ['startedAt','updatedAt','expiresAt']) integer(value[name],0,Number.MAX_SAFE_INTEGER);
  if (value.updatedAt < value.startedAt || value.expiresAt < value.startedAt || !Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 64) fail('INVALID','Invalid workflow record');
  const ids = new Set();
  for (const s of value.steps) {
    fields(s,['id','commandId','state','jobId','sourceAttemptId','inputSha256','output','outputSha256','artifacts','cache','reason','startedAt','finishedAt']);
    identifier(s.id); identifier(s.commandId); if (ids.has(s.id)) fail('INVALID','Duplicate record step'); ids.add(s.id);
    if (!states.includes(s.state)) fail('INVALID','Invalid step state');
    for (const k of ['jobId','sourceAttemptId']) if (s[k] !== null) identifier(s[k]);
    for (const k of ['inputSha256','outputSha256']) if (s[k] !== null) sha(s[k]);
    for (const k of ['startedAt','finishedAt']) if (s[k] !== null) integer(s[k],0,Number.MAX_SAFE_INTEGER);
    if (s.reason !== null) identifier(s.reason);
    if (s.cache !== null) cacheEvidence(s.cache);
    if (!Array.isArray(s.artifacts) || s.artifacts.length > 32) fail('LIMIT','Artifact limit'); s.artifacts.forEach(parseJobArtifact);
    if (s.state === 'succeeded') {jsonCopy(s.output); if (s.outputSha256 !== digest(canonical(s.output))) fail('INVALID','Output digest mismatch');}
    else if (s.output !== null || s.outputSha256 !== null || s.artifacts.length) fail('INVALID','Non-successful result');
  }
  return value;
}
export function recoverWorkflowRecord(input) {
  const value = clone(parseWorkflowRecord(input));
  if (value.state === 'running' || value.state === 'pending') {value.state = 'interrupted'; for (const s of value.steps) if (s.state === 'running' || s.state === 'pending') {s.state='interrupted'; s.reason='HOST_RESTART';}}
  return parseWorkflowRecord(value);
}
export function createMemoryWorkflowStore({maxRecords=64} = {}) {
  integer(maxRecords,1,64); const records = new Map();
  return Object.freeze({async read(id) {identifier(id); return records.get(id) ?? null;}, async write(input,expectedRevision) {const r=parseWorkflowRecord(input), old=records.get(r.attemptId); if ((old?.revision ?? 0)!==expectedRevision || r.revision!==expectedRevision+1) fail('CONFLICT','Workflow checkpoint changed'); if (!old && records.size>=maxRecords) fail('LIMIT','Workflow store full'); records.set(r.attemptId,r);}, async list() {return Object.freeze([...records.values()]);}});
}
export function createWorkflowRunner({commands,execute,authorize,store=createMemoryWorkflowStore(),now=Date.now} = {}) {
  if (typeof execute !== 'function' || typeof authorize !== 'function' || typeof now !== 'function') fail('INVALID','Host executor and authorization required');
  commands = jsonCopy(commands, WORKFLOW_LIMITS.planBytes); commands.forEach(command);
  let busy = false; const unsettled = new Set();
  const api = {
    inspect() {return Object.freeze({running:busy,unsettled:unsettled.size});},
    async recover(attemptId) {const value=await store.read(identifier(attemptId)); return value ? recoverWorkflowRecord(value) : null;},
    async run(plan, {approval,previous=null,parentJobId=null,signal} = {}) {
      if (busy || unsettled.size) fail('CONFLICT','Previous workflow is still active');
      fields(plan,['schemaVersion','definition','commands','sha256']);
      const current=prepareWorkflowPlan(plan.definition,commands); if (canonical(current)!==canonical(plan)) fail('CONFLICT','Plan or command schema changed');
      fields(approval,['approved','planSha256'],['previousAttemptId','retrySteps']);
      if (approval.approved!==true || approval.planSha256!==current.sha256) fail('DENIED','Exact reviewed workflow approval required');
      if (parentJobId!==null) identifier(parentJobId);
      if (previous!==null) {
        previous=recoverWorkflowRecord(previous);
        const stored=await store.read(previous.attemptId);
        if (!stored || canonical(recoverWorkflowRecord(stored))!==canonical(previous)) fail('CONFLICT','Resume requires the stored checkpoint');
        if (previous.planSha256!==current.sha256 || approval.previousAttemptId!==previous.attemptId || canonical(previous.scope)!==canonical(current.definition.scope) || previous.workflowId!==current.definition.id) fail('CONFLICT','Resume scope, input or schema changed');
      } else if (approval.previousAttemptId!==undefined || approval.retrySteps!==undefined) fail('INVALID','No previous attempt to resume');
      const definition=current.definition, byCommand=new Map(current.commands.map(c=>[c.id,c]));
      const retry=new Set(previous ? strings(approval.retrySteps ?? previous.steps.filter(s=>s.state!=='succeeded').map(s=>s.id)) : []);
      if ([...retry].some(id=>!definition.steps.some(s=>s.id===id))) fail('INVALID','Unknown retry step');
      for (const s of definition.steps) if (s.needs.some(id=>retry.has(id))) retry.add(s.id);
      // Propagate independent of declaration order.
      for (let i=0;i<definition.steps.length;i++) for (const s of definition.steps) if (s.needs.some(id=>retry.has(id))) retry.add(s.id);
      const startedAt=integer(now(),0,Number.MAX_SAFE_INTEGER), oldById=new Map((previous?.steps ?? []).map(s=>[s.id,s]));
      const record={schemaVersion:1,workflowId:definition.id,attemptId:randomUUID(),parentAttemptId:previous?.attemptId ?? null,parentJobId,planSha256:current.sha256,scope:clone(definition.scope),revision:0,state:'running',startedAt,updatedAt:startedAt,expiresAt:startedAt+definition.retentionMs,steps:definition.steps.map(s=>({id:s.id,commandId:s.commandId,state:'pending',jobId:null,sourceAttemptId:null,inputSha256:null,output:null,outputSha256:null,artifacts:[],cache:null,reason:null,startedAt:null,finishedAt:null}))};
      const byStep=new Map(record.steps.map(s=>[s.id,s])), clock=deadline(signal,definition.timeoutMs); let journalError=null, tail=Promise.resolve();
      if(busy||unsettled.size){clock.close();fail('CONFLICT','Previous workflow is still active');}busy=true;
      const checkpoint=()=>{
        const save=async()=>{record.revision++; record.updatedAt=now(); const copy=parseWorkflowRecord(record); await store.write(copy,copy.revision-1);};
        const pending=tail.then(save); tail=pending.catch(error=>{journalError=error;clock.controller.abort(error);}); return pending;
      };
      const access=(step,phase)=>authorized(authorize,{scope:definition.scope,command:byCommand.get(step.commandId),grants:step.grants,stepId:step.id,phase},clock.signal);
      const inputs=step=>validateDataValue(byCommand.get(step.commandId).inputSchema,Object.fromEntries(Object.entries(step.input).map(([k,b])=>[k,Object.hasOwn(b,'value') ? b.value : b.path.reduce((v,p)=>v[p],byStep.get(b.step).output)])));
      let usedBytes=0, failed=false;
      const executeStep=async step=>{
        const target=byStep.get(step.id), cmd=byCommand.get(step.commandId); let timer;
        try {
          await access(step,'before'); const input=inputs(step); target.inputSha256=digest(canonical(input));
          const prior=oldById.get(step.id);
          if (prior?.state==='succeeded' && !retry.has(step.id)) {
            if (previous.expiresAt<=now() || prior.inputSha256!==target.inputSha256) fail('EXPIRED','Partial result needs an explicit retry selection');
            const output=validateDataValue(cmd.outputSchema,prior.output); await access(step,'reuse');
            usedBytes+=Buffer.byteLength(canonical(output)); if(usedBytes>WORKFLOW_LIMITS.outputBytes) fail('LIMIT','Workflow output budget');
            Object.assign(target,{...clone(prior),sourceAttemptId:prior.sourceAttemptId ?? previous.attemptId,reason:'REUSED'}); return;
          }
          target.state='running'; target.startedAt=now(); target.jobId=randomUUID(); await checkpoint(); aborted(clock.signal);
          timer=deadline(clock.signal,definition.stepTimeoutMs);
          const pending=Promise.resolve().then(()=>execute(immutable(clone(step)),cmd,input,{signal:timer.signal,jobId:target.jobId,attemptId:record.attemptId,scope:definition.scope}));
          unsettled.add(pending); pending.then(()=>unsettled.delete(pending),()=>unsettled.delete(pending));
          const result=await interruptible(pending,timer.signal); fields(result,['output'],['artifacts','cache']);
          const output=validateDataValue(cmd.outputSchema,result.output), artifacts=(result.artifacts ?? []).map(parseJobArtifact);
          if(artifacts.length>32) fail('LIMIT','Artifact count'); await access(step,'after'); aborted(timer.signal);
          usedBytes+=Buffer.byteLength(canonical(output)); if(usedBytes>WORKFLOW_LIMITS.outputBytes) fail('LIMIT','Workflow output budget');
          const cache=result.cache===undefined?null:cacheEvidence(result.cache),reused=cache&&['hit','shared'].includes(cache.state);
          if(reused&&artifacts.length)fail('INVALID','Cached values cannot claim fresh mutable job artifacts');
          Object.assign(target,{state:'succeeded',output:clone(output),outputSha256:digest(canonical(output)),artifacts:clone(artifacts),cache:clone(cache),jobId:reused?null:target.jobId,reason:reused?'CACHE_'+cache.state.toUpperCase():'EXECUTED'});
        } catch(error) {
          const code=errorCode(error); Object.assign(target,{state:code==='TIMEOUT'?'timed_out':code==='CANCELLED'?'cancelled':'failed',reason:code,output:null,outputSha256:null,artifacts:[]});
          if(code!=='CANCELLED' && !(code==='TIMEOUT' && clock.signal.aborted)) failed=true;
          if(definition.policy==='fail-fast' && !clock.signal.aborted) clock.controller.abort(Object.assign(new Error('Dependent execution stopped'),{code:'CANCELLED'}));
        } finally {timer?.close(); target.finishedAt=now(); await checkpoint();}
      };
      try {
        await checkpoint(); const running=new Map();
        while(record.steps.some(s=>s.state==='pending') || running.size) {
          let progressed=false;
          for(const step of definition.steps) {
            const s=byStep.get(step.id); if(s.state!=='pending') continue;
            if(clock.signal.aborted) {s.state=clock.signal.reason?.code==='TIMEOUT'?'timed_out':'cancelled';s.reason=clock.signal.reason?.code==='TIMEOUT'?'TIMEOUT':'CANCELLED';progressed=true;continue;}
            if(step.needs.some(id=>['failed','cancelled','timed_out','blocked'].includes(byStep.get(id).state))) {s.state='blocked';s.reason='DEPENDENCY_FAILED';failed=true;progressed=true;continue;}
            if(running.size<definition.concurrency && step.needs.every(id=>byStep.get(id).state==='succeeded')) {
              // Mark before the first awaited authorization so another scheduler pass cannot launch twice.
              s.state='running'; const p=executeStep(step).finally(()=>running.delete(step.id)); running.set(step.id,p);progressed=true;
            }
          }
          if(running.size) await Promise.race(running.values());
          else if(!progressed && record.steps.some(s=>s.state==='pending')) fail('INVALID','Unschedulable workflow');
        }
        record.state=failed?'failed':clock.signal.aborted ? (clock.signal.reason?.code==='TIMEOUT'?'timed_out':'cancelled') : 'succeeded';
        await checkpoint(); if(journalError) throw journalError; return parseWorkflowRecord(record);
      } finally {clock.close();busy=false;await tail;}
    },
  }; return Object.freeze(api);
}

/** resolveHost must select an isolated, currently approved host for exactly these step grants. */
export function createCommandJobExecutor({resolveHost,pollMs=10}={}) {
  if(typeof resolveHost!=='function') fail('INVALID','Host resolver required'); integer(pollMs,1,1000);
  return async(step,command,input,{signal,jobId,scope:workflowScope})=>{
    const resolved=await resolveHost({step,command,grants:step.grants,scope:workflowScope});aborted(signal);
    fields(resolved,['host','scope','grants','pluginSha256']);
    if(canonical(resolved.grants)!==canonical(step.grants)||resolved.pluginSha256!==command.pluginSha256)fail('DENIED','Host grants or plugin pin differ from reviewed step');
    const host=resolved.host;
    let job;
    const check=()=>{if(job.jobId!==jobId||job.pluginId!==command.pluginId||job.commandId!==command.id||canonical(job.scope)!==canonical(resolved.scope))fail('CONFLICT','Job identity mismatch');};
    const cancel=()=>{try{Promise.resolve(host.cancelJob(jobId)).catch(()=>{});}catch{}};
    signal.addEventListener('abort',cancel,{once:true}); if(signal.aborted) cancel();
    try {
      aborted(signal);job=parseJobSnapshot(await host.startCommandJob(command.pluginId,command.id,input,{jobId}));check();aborted(signal);
      while(job.state==='running'){await pause(pollMs,signal);job=parseJobSnapshot(await host.getJob(jobId));check();}
      aborted(signal); if(job.state!=='succeeded') fail(job.state==='timed_out'?'TIMEOUT':job.state==='cancelled'?'CANCELLED':'FAILED','Command job did not succeed');
      return {output:job.result,artifacts:job.artifacts};
    } catch(error) {cancel();throw error;} finally {signal.removeEventListener('abort',cancel);}
  };
}
