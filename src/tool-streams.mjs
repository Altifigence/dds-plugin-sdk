import {parseJsonValue,parseWorkspacePath} from './contracts.mjs';

export const TOOL_STREAM_LIMITS=Object.freeze({chunkBytes:65_536,lineBytes:16_384,totalBytes:2_097_152,events:4096,queuedWrites:8,eventTimeoutMs:5000});
const failure=(code,message)=>{throw Object.assign(new Error(message),{code});};
const object=(value,required,optional=[])=>{if(!value||typeof value!=='object'||Array.isArray(value)||required.some(k=>!Object.hasOwn(value,k))||Object.keys(value).some(k=>![...required,...optional].includes(k)))failure('INVALID','Invalid tool stream contract');};
const text=(v,max=16_384)=>{if(typeof v!=='string'||v.length>max||!v.isWellFormed()||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v))failure('INVALID','Invalid stream text');return v;};
const id=v=>{if(typeof v!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(v))failure('INVALID','Invalid correlation identifier');return v;};
const integer=(v,max=Number.MAX_SAFE_INTEGER)=>{if(!Number.isSafeInteger(v)||v<0||v>max)failure('INVALID','Invalid stream number');return v;};
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const copy=value=>JSON.parse(JSON.stringify(parseJsonValue(value)));
const bytes=value=>new TextEncoder().encode(value).byteLength;
function range(value){object(value,['start','end']);for(const p of [value.start,value.end]){object(p,['line','character']);integer(p.line,10_000_000);integer(p.character,10_000_000);}if(value.end.line<value.start.line||value.end.line===value.start.line&&value.end.character<value.start.character)failure('INVALID','Invalid diagnostic range');}
function message(value){
  if(value.kind==='log'){object(value,['kind','level','message']);if(!['debug','info','warning','error'].includes(value.level))failure('INVALID','Invalid log level');text(value.message);}
  else if(value.kind==='progress'){object(value,['kind','completed','total'],['message']);integer(value.completed);integer(value.total);if(!value.total||value.completed>value.total)failure('INVALID','Invalid progress');if(value.message!==undefined)text(value.message,2048);}
  else if(value.kind==='diagnostic'){object(value,['kind','path','range','severity','message'],['code','source']);parseWorkspacePath(value.path);range(value.range);if(!['error','warning','info','hint'].includes(value.severity))failure('INVALID','Invalid diagnostic severity');text(value.message);if(value.code!==undefined)text(value.code,128);if(value.source!==undefined)text(value.source,128);}
  else if(value.kind==='unknown'){object(value,['kind','reason','message']);id(value.reason);text(value.message,1024);}
  else failure('UNSUPPORTED','Unsupported tool message');
  return value;
}
export function parseToolStreamEvent(input){
  const value=copy(input);object(value,['schemaVersion','sequence','jobId','commandId','toolId','toolVersion','stream','data']);
  if(value.schemaVersion!==1||!['stdout','stderr'].includes(value.stream))failure('INVALID','Invalid event');integer(value.sequence,TOOL_STREAM_LIMITS.events);if(value.sequence<1)failure('INVALID','Invalid sequence');
  id(value.jobId);id(value.commandId);id(value.toolId);text(value.toolVersion,96);message(value.data);return freeze(value);
}
export function parseTypeScriptDiagnosticLine(line){
  text(line);const match=/^(.+)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/.exec(line);
  if(!match)return null;const row=Number(match[2]),column=Number(match[3]);if(row<1||column<1)return null;
  const position={line:row-1,character:column-1};const value={kind:'diagnostic',path:match[1].replaceAll('\\','/'),range:{start:position,end:{...position}},severity:match[4],code:match[5],message:match[6],source:'typescript'};
  return freeze(message(value));
}

/** Bounded, portable decoder. Callers await write() and finish(); no process or network authority. */
export function createToolStreamParser({format='jsonl',parser='plain',jobId,commandId,toolId,toolVersion,onEvent,secrets=[],sensitivePaths=[],signal,maxLineBytes=TOOL_STREAM_LIMITS.lineBytes,maxTotalBytes=TOOL_STREAM_LIMITS.totalBytes,maxEvents=TOOL_STREAM_LIMITS.events,eventTimeoutMs=TOOL_STREAM_LIMITS.eventTimeoutMs}={}){
  if(!['jsonl','text'].includes(format)||!['plain','typescript'].includes(parser)||typeof onEvent!=='function')failure('INVALID','Invalid stream parser');
  id(jobId);id(commandId);id(toolId);text(toolVersion,96);
  for(const [v,max] of [[maxLineBytes,TOOL_STREAM_LIMITS.lineBytes],[maxTotalBytes,TOOL_STREAM_LIMITS.totalBytes],[maxEvents,TOOL_STREAM_LIMITS.events],[eventTimeoutMs,TOOL_STREAM_LIMITS.eventTimeoutMs]]){integer(v,max);if(v<1)failure('INVALID','Invalid stream limit');}
  if(!Array.isArray(secrets)||!Array.isArray(sensitivePaths)||secrets.length>32||sensitivePaths.length>32)failure('LIMIT','Masking input limit');
  const masks=[...secrets,...sensitivePaths].map(v=>{text(v,4096);if(!v||/[\r\n]/.test(v))failure('INVALID','Masks must be nonempty single-line text');return v;}).sort((a,b)=>b.length-a.length);
  const redact=value=>masks.reduce((s,mask)=>s.split(mask).join('[redacted]'),value);
  const streams={stdout:{decoder:new TextDecoder('utf-8',{fatal:true}),pending:''},stderr:{decoder:new TextDecoder('utf-8',{fatal:true}),pending:''}};
  let tail=Promise.resolve(),queued=0,total=0,sequence=0,unknown=0,closed=false,finishing=false,fatal=null,peakQueued=0;
  const check=()=>{if(fatal)throw fatal;if(closed)failure('DISPOSED','Parser closed');if(signal?.aborted)failure('CANCELLED','Stream cancelled');};
  async function emit(data,stream){
    check();if(sequence>=maxEvents)failure('LIMIT','Tool event budget');sequence++;
    for(const key of ['message','source','code'])if(typeof data[key]==='string')data[key]=redact(data[key]);
    // Relative diagnostic locations are data, and are not emitted when a mask would make them invalid.
    if(data.kind==='diagnostic'&&redact(data.path)!==data.path)data={kind:'unknown',reason:'masked-path',message:redact(data.message).slice(0,1024)};
    const event=parseToolStreamEvent({schemaVersion:1,sequence,jobId,commandId,toolId,toolVersion,stream,data});
    if(event.data.kind==='unknown')unknown++;
    let timer,cancel;
    try{await Promise.race([Promise.resolve().then(()=>onEvent(event)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('Event sink deadline'),{code:'TIMEOUT'})),eventTimeoutMs);cancel=()=>reject(Object.assign(new Error('Stream cancelled'),{code:'CANCELLED'}));signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();})]);}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
    check();
  }
  async function line(value,stream){
    if(value.endsWith('\r'))value=value.slice(0,-1);if(bytes(value)>maxLineBytes)failure('LIMIT','Tool line budget');if(!value)return;
    let data;
    try{
      if(format==='jsonl')data=message(JSON.parse(value));
      else data=parser==='typescript'?parseTypeScriptDiagnosticLine(value):null;
      if(!data)data={kind:'log',level:stream==='stderr'?'warning':'info',message:value};
    }catch{data={kind:'unknown',reason:format==='jsonl'?'invalid-jsonl':'invalid-diagnostic',message:redact(value).slice(0,1024)};}
    await emit({...data},stream);
  }
  async function consume(chunk,stream,final=false){
    check();const state=streams[stream];let decoded;
    try{decoded=state.decoder.decode(chunk,{stream:!final});}catch{failure('INVALID','Malformed UTF-8 output');}
    let start=0;
    for(let at=decoded.indexOf('\n');at!==-1;at=decoded.indexOf('\n',start)){
      const part=state.pending+decoded.slice(start,at);state.pending='';await line(part,stream);start=at+1;
    }
    state.pending+=decoded.slice(start);if(bytes(state.pending)>maxLineBytes)failure('LIMIT','Unterminated tool line budget');
    if(final&&state.pending){const last=state.pending;state.pending='';await line(last,stream);}
  }
  function enqueue(action){if(queued>=TOOL_STREAM_LIMITS.queuedWrites)failure('LIMIT','Await stream backpressure');queued++;peakQueued=Math.max(peakQueued,queued);const p=tail.then(action);tail=p.catch(e=>{fatal=e;}).finally(()=>queued--);return p;}
  return Object.freeze({
    write(input,stream='stdout'){
      check();if(finishing)failure('DISPOSED','Parser finishing');if(!Object.hasOwn(streams,stream)||!(input instanceof Uint8Array))failure('INVALID','Expected output bytes and stream');
      if(input.byteLength>TOOL_STREAM_LIMITS.chunkBytes||total+input.byteLength>maxTotalBytes)failure('LIMIT','Tool output byte budget');const chunk=Uint8Array.from(input);total+=chunk.length;
      return enqueue(()=>consume(chunk,stream));
    },
    async finish(){check();if(finishing)failure('DISPOSED','Parser finishing');finishing=true;await enqueue(async()=>{await consume(new Uint8Array(),'stdout',true);await consume(new Uint8Array(),'stderr',true);});closed=true;return {bytes:total,events:sequence,unknown,peakQueued};},
    dispose(){closed=true;for(const state of Object.values(streams))state.pending='';},
    inspect(){return {bytes:total,events:sequence,unknown,queued,peakQueued,closed,failed:!!fatal};},
  });
}

/** Connect tool progress/logs to an existing JobReporter; diagnostics stay a caller-owned stream. */
export function createJobToolEventSink(job,{onDiagnostic=()=>{}}={}){
  if(!job||typeof job.reportProgress!=='function'||typeof job.log!=='function'||typeof onDiagnostic!=='function')failure('INVALID','Job reporter required');
  return async input=>{const event=parseToolStreamEvent(input),data=event.data;
    if(data.kind==='progress'){const {kind,...progress}=data;job.reportProgress(progress);}
    else if(data.kind==='log')job.log(data.level,data.message);
    else if(data.kind==='diagnostic')await onDiagnostic(event);
    else job.log('warning',`Unrecognized tool message (${data.reason})`);
  };
}
