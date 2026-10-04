import {createPluginHost} from './host.mjs';
import {parseGrants,parseScope,parseJsonValue} from './contracts.mjs';
import {ErrorCode} from './limits.mjs';
import {configurationObject as object,configurationKey as key} from './configuration-values.mjs';
import {createSettingsStore} from './settings.mjs';
import {createSecretResolver,SECRET_LIMITS} from './secrets.mjs';
import {createTestClock,createTestResources,testFailure,flushTestMicrotasks} from './testing-runtime.mjs';
import {createFaultController} from './testing-faults.mjs';
import {createMemoryWorkspace} from './testing-workspace.mjs';

function entries(value){if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw testFailure(ErrorCode.INVALID_CONTRACT);return Reflect.ownKeys(value).map(name=>{const d=Object.getOwnPropertyDescriptor(value,name);if(typeof name!=='string'||!d?.enumerable||!('value'in d))throw testFailure(ErrorCode.INVALID_CONTRACT);key(name);return [name,d.value];});}
/** In-process synthetic fixtures. All host grants and mounted capabilities are explicit. */
export function createScenarioHost(options={}){
  object(options,[],['seed','start','scope','hostId','grants','files','backends','settings','secrets','jobs','binaryArtifacts','jobStorage']);
  let grants=parseGrants(options.grants??[]),closed=false;const scope=parseScope(options.scope??{projectId:'synthetic-project',sessionId:'synthetic-session'});
  const clock=createTestClock({seed:options.seed??1,start:options.start??1700000000000}),faults=createFaultController(clock.runtime),resources=createTestResources();
  const workspace=options.files===undefined?null:createMemoryWorkspace({files:options.files,runtime:clock.runtime,faults,authorize:kind=>grants.includes(kind==='write'?'workspace.write':'workspace.read')});
  const mounted=Object.fromEntries(entries(options.backends??{}).map(([name,value])=>{const result=parseJsonValue(value);return [name,(_input,{signal})=>faults.invoke('backend.'+name,()=>{if(!grants.includes('backend.invoke'))throw testFailure(ErrorCode.PERMISSION_DENIED);return result;},{signal})];}));
  if(!Array.isArray(options.settings??[])||(options.settings??[]).length>32)throw testFailure(ErrorCode.INVALID_CONTRACT);
  const stores=new Map();for(const definition of options.settings??[]){const store=createSettingsStore(definition,{runtime:clock.runtime});if(stores.has(store.definition.pluginId))throw testFailure(ErrorCode.INVALID_CONTRACT);stores.set(store.definition.pluginId,store);}
  const materials=new Map(entries(options.secrets??{}).map(([name,value])=>{if(!(value instanceof Uint8Array)||value.length<1||value.length>SECRET_LIMITS.valueBytes)throw testFailure(ErrorCode.INVALID_CONTRACT);return [name,value.slice()];}));
  const secrets=options.secrets===undefined?null:createSecretResolver({runtime:clock.runtime,authorize:()=>grants.includes('secrets.resolve'),resolve:({secretId},{signal})=>faults.invoke('secret.resolve',()=>{const value=materials.get(secretId);if(!value)throw testFailure(ErrorCode.CAPABILITY_UNAVAILABLE);return value;},{signal})});
  const settings=Object.freeze(Object.fromEntries(stores));
  const settingPorts=Object.fromEntries([...stores].map(([id,store])=>[id,{read(workspaceId,{signal}={}){return faults.invoke('settings.read',()=>{if(!grants.includes('settings.read'))throw testFailure(ErrorCode.PERMISSION_DENIED);return store.read(workspaceId);},{signal});},subscribe:(workspaceId,callback)=>store.subscribe(workspaceId,callback)}]));
  const host=createPluginHost({hostId:options.hostId??'workspace-host',scope,grants,runtime:clock.runtime,...(workspace?{workspace:workspace.port}:{}),backends:mounted,settings:settingPorts,...(secrets?{secrets}:{}),jobs:options.jobs??false,binaryArtifacts:options.binaryArtifacts??false,...(options.jobStorage!==undefined?{jobStorage:options.jobStorage}:{})});
  const capabilities=Object.freeze({workspace:!!workspace,backends:Object.freeze(Object.keys(mounted)),settings:Object.freeze([...stores.keys()]),secrets:!!secrets,jobs:host.jobCapabilities().enabled,binaryArtifacts:host.binaryArtifactCapabilities().enabled});
  return Object.freeze({host,clock,faults,workspace,settings,secrets,resources,capabilities,
    replaceGrants(next){if(closed)throw testFailure(ErrorCode.DISPOSED);next=parseGrants(next);host.replaceGrants(next);grants=next;},
    inspect(){return Object.freeze({host:host.inspect(),clock:clock.inspect(),faults:faults.inspect(),workspace:workspace?.inspect()??null,settings:Object.freeze(Object.fromEntries([...stores].map(([name,store])=>[name,store.inspect()]))),secrets:secrets?.inspect()??null,resources:resources.inspect()});},
    async dispose(){if(!closed){closed=true;host.dispose();faults.dispose();workspace?.dispose();for(const store of stores.values())store.dispose();secrets?.dispose();for(const bytes of materials.values())bytes.fill(0);materials.clear();}await resources.dispose();await flushTestMicrotasks();},
    assertClean(){const h=host.inspect();if(h.plugins||h.commands||h.registrations||h.pendingActivations||h.pendingOperations||h.providerOperations||h.pendingJobs||h.binaryOperations||h.pendingCheckpoints||h.timers||clock.inspect().timers||faults.inspect().pending||workspace?.inspect().subscriptions||workspace?.inspect().handles||[...stores.values()].some(s=>s.inspect().subscriptions||s.inspect().pendingMigrations)||secrets?.inspect().pending)throw testFailure(ErrorCode.CONFLICT);resources.assertEmpty();},
  });
}
