import {createPluginHost,type HostRuntime,type JsonValue} from '@altifigence/dds-plugin-sdk';
import {initPlugin,planPlugin,generatePluginContracts,parseDevelopmentDefinition,PLUGIN_TEMPLATES,runPluginDev,type PluginPlan} from '@altifigence/dds-plugin-sdk/devtools';
import {createScenarioHost,createTestClock,createFaultController,createMemoryWorkspace,createTestResources,createMemoryJobStore,createTestRecorder,createTestReplay,parseTestTrace,type TestTraceOptions} from '@altifigence/dds-plugin-sdk/testing';
import {createDiagnosticSession,profileHost,profileTransport,parseDiagnosticReport} from '@altifigence/dds-plugin-sdk/diagnostics';
import {SCHEMAS} from '@altifigence/dds-plugin-sdk/schemas';

const clock=createTestClock({seed:17}),runtime:HostRuntime=clock.runtime;
const host=createPluginHost({runtime});host.replaceGrants(['document.read']);void host.inspect().pendingActivations;void host.inspect().pendingCheckpoints;
const planned:Promise<PluginPlan>=initPlugin('/operator/new-plugin',{template:'language',dryRun:true});void planned;
void initPlugin('/operator/new-plugin',{template:'configuration'}).then(plugin=>plugin.files.map(name=>name.toUpperCase()));
void planPlugin('/operator/new-plugin',{license:'LicenseRef-Proprietary',licenseFile:'/operator/terms.txt'});void generatePluginContracts('/operator/plugin',{expectedDigest:'a'.repeat(64)});void parseDevelopmentDefinition({});void PLUGIN_TEMPLATES;
// @ts-expect-error templates are closed, executable names are not templates
void initPlugin('/operator/new-plugin',{template:'arbitrary-executable'});
// @ts-expect-error template license must be reviewed and supported
void initPlugin('/operator/new-plugin',{license:'unknown'});
const scenario=createScenarioHost({files:{'example.txt':'synthetic'},backends:{analyzer:{ok:true}},settings:[],secrets:{token:new Uint8Array([1])}});
const workspace=createMemoryWorkspace({runtime,files:{'example.txt':'text'}});void workspace.port.readFile('example.txt',{signal:new AbortController().signal});void workspace.snapshot();void scenario.inspect();
const faults=createFaultController(runtime);faults.enqueue({operation:'file.read',kind:'delay',delayMs:10});faults.enqueue({operation:'file.chunk',kind:'corrupt',value:{}});void faults.invoke('example',()=>({ok:true}));
// @ts-expect-error delays are mandatory for delay faults
faults.enqueue({operation:'file.read',kind:'delay'});
const resources=createTestResources();void resources.track('process',async()=>{}).release();void resources.dispose();
// @ts-expect-error resources track fixed owner-selected kinds
resources.track('all-system-processes',()=>{});
const store=createMemoryJobStore({identity:{schemaVersion:1,storeId:crypto.randomUUID(),workspaceId:'synthetic',workspaceIdentity:'a'.repeat(64)}});void store.snapshot();
const fixtures:TestTraceOptions={synthetic:true,seed:1,fixtureVersion:1,fixtures:[{id:'synthetic',operation:'command',input:{},output:{ok:true}}]};const recorder=createTestRecorder({...fixtures,now:clock.now});recorder.record('synthetic',{},{ok:true});const trace=parseTestTrace(recorder.snapshot()),replay=createTestReplay(trace,fixtures);const value:JsonValue=replay.next('synthetic',{});void value;
// @ts-expect-error recording requires the caller's explicit synthetic opt-in
createTestRecorder({seed:1,fixtureVersion:1,fixtures:[]});
const diagnostics=createDiagnosticSession({enabled:true,now:clock.now}),span=diagnostics.begin('command',{inputBytes:20});span.end({outputBytes:10,resources:{memoryBytes:100}});const number:number=diagnostics.measure('command',()=>42);void number;
const asyncResult:Promise<number>=diagnostics.measure('transport',async()=>42);void asyncResult;void profileHost(host,diagnostics);void profileTransport(fetch,diagnostics);void parseDiagnosticReport(diagnostics.snapshot());
// @ts-expect-error error text is never part of diagnostic metadata
span.end({message:'private'});
// @ts-expect-error metric names do not allow arbitrary paths
diagnostics.begin('/operator/private');
void runPluginDev('/operator/plugin',{trustLocalCode:true,debug:true,debugWait:true,profile:true,onEvent(event){if(event.type==='debug')void event.url;if(event.type==='profile')void event.report;}});
void SCHEMAS['test-trace'];void SCHEMAS['development-definition'];void SCHEMAS['diagnostic-report'];
