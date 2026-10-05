import {canonical,fail,fields,integer,jsonCopy,deadline,aborted,errorCode} from './workflow-internals.mjs';

export const LSP_LIMITS=Object.freeze({messageBytes:1_048_576,headerBytes:8192,sessionBytes:67_108_864,messages:20_000,pendingRequests:16,queuedWrites:16,timeoutMs:30_000,documents:32,documentBytes:4_194_304,stderrBytes:65_536});
export function encodeLspMessage(message){const body=Buffer.from(canonical(message,LSP_LIMITS.messageBytes));return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`,'ascii'),body]);}
export function createLspFrameDecoder(){
  let buffer=Buffer.alloc(0),expected=null,total=0,messages=0,failed=false;
  return Object.freeze({
    push(input){
      if(failed)fail('DISPOSED','Decoder failed');if(!(input instanceof Uint8Array)||input.byteLength>65_536)fail('LIMIT','LSP input chunk limit');
      try{
        total+=input.byteLength;if(total>LSP_LIMITS.sessionBytes)fail('LIMIT','LSP session byte budget');buffer=Buffer.concat([buffer,Buffer.from(input)]);const output=[];
        while(true){
          if(expected===null){
            const end=buffer.indexOf('\r\n\r\n');if(end<0){if(buffer.length>LSP_LIMITS.headerBytes)fail('LIMIT','LSP header budget');break;}
            if(end>LSP_LIMITS.headerBytes)fail('LIMIT','LSP header budget');const raw=buffer.subarray(0,end);if([...raw].some(b=>b!==13&&b!==10&&(b<32||b>126)))fail('INVALID','LSP headers must be ASCII');
            const headers=new Map();for(const line of raw.toString('ascii').split('\r\n')){const split=line.indexOf(':');if(split<1)fail('INVALID','Malformed LSP header');const key=line.slice(0,split).toLowerCase(),value=line.slice(split+1).trim();if(headers.has(key)||!['content-length','content-type'].includes(key))fail('INVALID','Duplicate or unknown LSP header');headers.set(key,value);}
            const length=headers.get('content-length');if(!/^(0|[1-9]\d*)$/.test(length??''))fail('INVALID','Invalid LSP content length');expected=Number(length);integer(expected,2,LSP_LIMITS.messageBytes);
            if(headers.has('content-type')&&!/^application\/vscode-jsonrpc(?:\s*;\s*charset\s*=\s*(?:utf-8|utf8))?$/i.test(headers.get('content-type')))fail('UNSUPPORTED','LSP encoding is not UTF-8');
            buffer=buffer.subarray(end+4);
          }
          if(buffer.length<expected)break;
          const message=jsonCopy(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,expected))),LSP_LIMITS.messageBytes);
          if(!message||typeof message!=='object'||Array.isArray(message)||message.jsonrpc!=='2.0')fail('INVALID','Invalid JSON-RPC envelope');
          if(++messages>LSP_LIMITS.messages)fail('LIMIT','LSP message budget');output.push(message);buffer=buffer.subarray(expected);expected=null;
        }
        return output;
      }catch(e){failed=true;buffer=Buffer.alloc(0);throw e;}
    },
    finish(){if(buffer.length||expected!==null)fail('INVALID','Incomplete LSP frame');},
    inspect(){return {bufferedBytes:buffer.length,totalBytes:total,messages,failed};},
  });
}

export function createLspRpc(proc,{signal,onNotification=async()=>{},onRequest=async()=>{throw Object.assign(new Error('Unsupported server request'),{code:'UNSUPPORTED'});},timeoutMs=5000}={}){
  integer(timeoutMs,1,LSP_LIMITS.timeoutMs);const decoder=createLspFrameDecoder(),pending=new Map();let nextId=0,closed=false,fatal=null,tail=Promise.resolve(),queued=0,stderrBytes=0,lateResponses=0,unsupportedRequests=0;
  const stop=error=>{if(closed)return;closed=true;fatal=error;for(const p of pending.values())p.reject(error);pending.clear();proc.stop().catch(()=>{});};
  function send(value,skip=()=>false){
    if(closed)return Promise.reject(fatal??Object.assign(new Error('LSP closed'),{code:'DISPOSED'}));if(queued>=16)return Promise.reject(Object.assign(new Error('LSP write queue full'),{code:'LIMIT'}));
    const bytes=encodeLspMessage(value);queued++;const p=tail.then(()=>{if(skip())return;if(closed)throw fatal??Object.assign(new Error('LSP closed'),{code:'DISPOSED'});return new Promise((resolve,reject)=>proc.child.stdin.write(bytes,error=>error?reject(Object.assign(new Error('LSP write failed'),{code:'SERVER_EXIT'})):resolve()));});
    tail=p.catch(error=>{stop(error);}).finally(()=>queued--);return p;
  }
  const notify=(method,params)=>send({jsonrpc:'2.0',method,...(params===undefined?{}:{params})});
  async function dispatch(message){
    if(typeof message.method==='string'){
      fields(message,['jsonrpc','method'],['id','params']);if(message.method.length>256)fail('INVALID','RPC method too long');
      if(Object.hasOwn(message,'id')){
        if(!(Number.isSafeInteger(message.id)||typeof message.id==='string'&&message.id.length<=128))fail('INVALID','Invalid RPC request ID');
        try{const result=await onRequest(message.method,message.params);await send({jsonrpc:'2.0',id:message.id,result:result??null});}
        catch{unsupportedRequests++;await send({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Unsupported by the reviewed DDS LSP bridge'}});}
      }else await onNotification(message.method,message.params);
      return;
    }
    fields(message,['jsonrpc','id'],['result','error']);if(Object.hasOwn(message,'result')===Object.hasOwn(message,'error'))fail('INVALID','RPC response requires result or error');
    if(message.error!==undefined&&(!message.error||!Number.isSafeInteger(message.error.code)||typeof message.error.message!=='string'))fail('INVALID','Invalid RPC error');
    const waiting=pending.get(message.id);if(!waiting){lateResponses++;return;}pending.delete(message.id);
    if(message.error!==undefined){waiting.reject(Object.assign(new Error('Language server rejected request'),{code:message.error.code===-32601?'UNSUPPORTED':'SERVER_ERROR',rpcCode:message.error.code}));}
    else waiting.resolve(message.result);
  }
  const reads=(async()=>{try{for await(const chunk of proc.child.stdout){for(const message of decoder.push(chunk))await dispatch(message);}decoder.finish();if(!closed)stop(Object.assign(new Error('Language server closed stdout'),{code:'SERVER_EXIT'}));}catch(error){stop(error);}})();
  const errors=(async()=>{try{for await(const chunk of proc.child.stderr){stderrBytes+=chunk.length;if(stderrBytes>LSP_LIMITS.stderrBytes)fail('LIMIT','Language server stderr budget');}}catch(error){stop(error);}})();
  const abort=()=>stop(Object.assign(new Error('LSP lifecycle cancelled'),{code:'CANCELLED'}));signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  proc.finished.then(()=>{if(!closed)stop(Object.assign(new Error('Language server exited'),{code:'SERVER_EXIT'}));});
  return Object.freeze({
    notify,
    async request(method,params,{signal:requestSignal,timeoutMs:limit=timeoutMs}={}){
      if(closed)throw fatal??Object.assign(new Error('LSP closed'),{code:'DISPOSED'});if(pending.size>=16)fail('LIMIT','LSP request concurrency');integer(limit,1,LSP_LIMITS.timeoutMs);
      const clock=deadline(requestSignal,limit);const id=++nextId;let cancel;
      try{
        aborted(clock.signal);
        return await new Promise((resolve,reject)=>{
          pending.set(id,{resolve,reject});cancel=()=>{if(!pending.delete(id))return;reject(Object.assign(new Error('LSP request stopped'),{code:clock.signal.reason?.code==='TIMEOUT'?'TIMEOUT':'CANCELLED'}));if(!closed)notify('$/cancelRequest',{id}).catch(()=>{});};
          clock.signal.addEventListener('abort',cancel,{once:true});if(clock.signal.aborted){cancel();return;}
          send({jsonrpc:'2.0',id,method,...(params===undefined?{}:{params})},()=>!pending.has(id)).catch(error=>{pending.delete(id);reject(error);});
        });
      }finally{if(cancel)clock.signal.removeEventListener('abort',cancel);clock.close();pending.delete(id);}
    },
    inspect(){return {closed,pending:pending.size,queued,stderrBytes,lateResponses,unsupportedRequests,failure:fatal?errorCode(fatal):null,...decoder.inspect()};},
    async close(){closed=true;signal?.removeEventListener('abort',abort);for(const p of pending.values())p.reject(Object.assign(new Error('LSP closed'),{code:'DISPOSED'}));pending.clear();await proc.stop();await Promise.allSettled([reads,errors,tail]);},
  });
}
