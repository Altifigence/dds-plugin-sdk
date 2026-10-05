import {canonical,clone,digest,exactVersion,fail,fields,portablePath,sha,sourceUrl,string} from './release-internals.mjs';

function source(value,loopback=false){fields(value,['url','version','sha256']);return {url:sourceUrl(value.url,loopback),version:exactVersion(value.version),sha256:sha(value.sha256)};}
/** Developer-triggered fetch only. Redirect targets must also be exact allowlisted URLs. */
export async function fetchUpstreamArtifact(options){
  fields(options,['source','allowedUrls','enabled','offline','maxBytes','timeoutMs'],['allowLoopback','signal']);
  const target=source(options.source,options.allowLoopback===true);
  if(options.enabled!==true)fail('APPROVAL_REQUIRED','Explicit upstream checking configuration is required');
  if(typeof options.offline!=='boolean'||!Array.isArray(options.allowedUrls)||!options.allowedUrls.length||options.allowedUrls.length>32)fail('INVALID','Explicit offline policy and allowlist required');
  const allowed=new Set(options.allowedUrls.map(url=>sourceUrl(url,options.allowLoopback===true)));
  if(!allowed.has(target.url))fail('SOURCE_DENIED','Source is outside the configured allowlist');
  if(!Number.isSafeInteger(options.maxBytes)||options.maxBytes<1||options.maxBytes>48*1024*1024||!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>60000)fail('LIMIT','Invalid fetch budget');
  const receipt={schemaVersion:1,source:target,observedAt:Date.now(),status:'unverified',actualSha256:null,bytes:0,redirects:[],reason:null};
  if(options.offline)return {...receipt,status:'offline',reason:'network-disabled',artifact:null};
  const abort=new AbortController(),cancel=()=>abort.abort();
  if(options.signal?.aborted)abort.abort();else options.signal?.addEventListener('abort',cancel,{once:true});
  let timedOut=false;const timer=setTimeout(()=>{timedOut=true;abort.abort();},options.timeoutMs);let response;
  try{
    let url=target.url;
    for(let n=0;n<=3;n++){
      if(abort.signal.aborted)throw new Error('aborted');
      response=await fetch(url,{redirect:'manual',signal:abort.signal,credentials:'omit',headers:{accept:'application/octet-stream'}});
      if([301,302,303,307,308].includes(response.status)){
        const location=response.headers.get('location');await response.body?.cancel();
        if(!location||n===3)fail('REDIRECT','Invalid or excessive redirects');
        const next=sourceUrl(new URL(location,url).href,options.allowLoopback===true);
        if(!allowed.has(next))fail('SOURCE_DENIED','Redirect target outside configured allowlist');
        receipt.redirects.push(next);url=next;continue;
      }
      break;
    }
    if(!response.ok){await response.body?.cancel();return {...receipt,status:response.status===404?'unavailable':'unverified',reason:`http-${response.status}`,artifact:null};}
    const declared=response.headers.get('content-length');
    if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>options.maxBytes))fail('LIMIT','Response exceeds byte budget');
    if(!response.body)fail('INVALID','Missing upstream response body');
    const reader=response.body.getReader(),chunks=[];let length=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;if((length+=value.byteLength)>options.maxBytes)fail('LIMIT','Response exceeds byte budget');chunks.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    const bytes=Buffer.concat(chunks,length),actual=digest(bytes);
    return {...receipt,observedAt:Date.now(),status:actual===target.sha256?'verified':'digest-mismatch',actualSha256:actual,bytes:length,reason:actual===target.sha256?null:'source-or-tag-changed',artifact:actual===target.sha256?Uint8Array.from(bytes):null};
  }catch(error){return {...receipt,observedAt:Date.now(),status:'unverified',reason:options.signal?.aborted?'cancelled':timedOut?'timeout':error.code??'network-failed',artifact:null};}
  finally{clearTimeout(timer);options.signal?.removeEventListener('abort',cancel);await response?.body?.cancel().catch(()=>{});}
}
function manifest(value){
  fields(value,['schemaVersion','name','version','revision','api','license','files']);
  if(value.schemaVersion!==1)fail('UNSUPPORTED','Unsupported upstream manifest');
  string(value.name,'upstream name',128);exactVersion(value.version);string(value.revision,'upstream revision',128);
  if(!Array.isArray(value.api)||value.api.length>4096||new Set(value.api).size!==value.api.length)fail('LIMIT','Invalid upstream API inventory');for(const api of value.api)string(api,'API name',256);
  fields(value.license,['name','text','notice','redistributable']);string(value.license.name,'license',256);
  if(typeof value.license.text!=='string'||!value.license.text.trim()||value.license.text.length>128*1024||typeof value.license.notice!=='string'||value.license.notice.length>128*1024||typeof value.license.redistributable!=='boolean')fail('INVALID','License/NOTICE and redistribution decision required');
  if(!Array.isArray(value.files)||value.files.length>4096)fail('LIMIT','Invalid upstream file inventory');const names=new Set();
  for(const file of value.files){fields(file,['path','sha256']);portablePath(file.path);sha(file.sha256);if(names.has(file.path.toLowerCase()))fail('INVALID','Duplicate upstream path');names.add(file.path.toLowerCase());}
  return clone(value);
}
/** Adapters publish reviewed metadata in this format. Inventory claims are not a code execution test. */
export function createUpstreamManifest(value){return manifest({schemaVersion:1,...value});}
export function inspectUpstreamManifest(bytes,declaredSource,observedAt){
  const declared=source(declaredSource,true);
  if(!(bytes instanceof Uint8Array)||bytes.byteLength>1024*1024||!Number.isSafeInteger(observedAt)||observedAt<0)fail('LIMIT','Invalid manifest bytes/time');
  if(digest(bytes)!==declared.sha256)fail('INTEGRITY','Upstream source digest mismatch');
  let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('INVALID','Invalid upstream JSON');}
  value=manifest(value);if(value.version!==declared.version)fail('CONFLICT','Upstream version mismatch');
  return {schemaVersion:1,source:declared,observedAt,manifest:value,manifestSha256:digest(canonical(value))};
}
function checkedSnapshot(value){fields(value,['schemaVersion','source','observedAt','manifest','manifestSha256']);source(value.source,true);const checked=manifest(value.manifest);if(value.schemaVersion!==1||value.source.version!==checked.version||digest(canonical(checked))!==sha(value.manifestSha256)||!Number.isSafeInteger(value.observedAt)||value.observedAt<0)fail('INVALID','Invalid upstream snapshot');return clone(value);}
/** Creates review data only; check is a developer-owned functional adapter test port. */
export async function createUpstreamCandidate(options){
  fields(options,['current','candidate','support'],['check','signal']);
  const current=checkedSnapshot(options.current),candidate=checkedSnapshot(options.candidate);
  if(current.manifest.name!==candidate.manifest.name)fail('CONFLICT','Upstream identity changed');
  fields(options.support,['versions','requiredApi']);
  for(const key of ['versions','requiredApi'])if(!Array.isArray(options.support[key])||options.support[key].length>4096)fail('LIMIT','Invalid adapter support matrix');
  for(const version of options.support.versions)exactVersion(version);for(const name of options.support.requiredApi)string(name,'API name',256);
  const removedApi=current.manifest.api.filter(x=>!candidate.manifest.api.includes(x)),addedApi=candidate.manifest.api.filter(x=>!current.manifest.api.includes(x));
  const oldFiles=new Map(current.manifest.files.map(x=>[x.path,x.sha256])),newFiles=new Map(candidate.manifest.files.map(x=>[x.path,x.sha256]));
  const files={added:[...newFiles.keys()].filter(x=>!oldFiles.has(x)).sort(),removed:[...oldFiles.keys()].filter(x=>!newFiles.has(x)).sort(),changed:[...newFiles.keys()].filter(x=>oldFiles.has(x)&&oldFiles.get(x)!==newFiles.get(x)).sort()};
  const missingApi=options.support.requiredApi.filter(x=>!candidate.manifest.api.includes(x));
  let functional={state:'unverified',detail:'No developer adapter check supplied'};
  if(options.signal?.aborted)functional={state:'unverified',detail:'cancelled'};
  else if(options.check){
    try{const result=await options.check(clone(candidate),{signal:options.signal});fields(result,['passed','detail']);if(typeof result.passed!=='boolean')fail('INVALID','Invalid functional check');string(result.detail,'check detail',2048);functional={state:result.passed?'passed':'failed',detail:result.detail};}catch{functional={state:'failed',detail:'Developer adapter check failed'};}
  }
  if(options.signal?.aborted)functional={state:'unverified',detail:'cancelled'};
  const supported=options.support.versions.includes(candidate.manifest.version)&&!missingApi.length;
  const body={schemaVersion:1,current,candidate,tagChanged:current.source.url===candidate.source.url&&current.source.version===candidate.source.version&&current.source.sha256!==candidate.source.sha256,api:{added:addedApi.sort(),removed:removedApi.sort(),missingRequired:missingApi.sort()},files,licenseChanged:canonical(current.manifest.license)!==canonical(candidate.manifest.license),redistributable:candidate.manifest.license.redistributable,compatibility:!supported?'unsupported':functional.state==='passed'?'supported':'unverified',functional,patch:{expectedSourceSha256:current.source.sha256,replacementSource:clone(candidate.source)},reviewRequired:true,automaticActions:[]};
  return {...body,sha256:digest(canonical(body,2*1024*1024))};
}
