import {verify,rejected,fixtureManifest,fixturePlugin} from './conformance-host.mjs';
export const DEVELOPMENT_CASES={
  async localization(ctx) {
    const api=ctx.adapters.localization,catalog={schemaVersion:1,defaultLocale:'en',messages:{en:{hello:'Hello {name}'},ko:{hello:'안녕 {name}'}}};
    const ko=api.resolveMessage(catalog,'ko','hello',{name:'SDK'}),fallback=api.resolveMessage(catalog,'fr','hello',{name:'SDK'});
    verify(ko.text==='안녕 SDK'&&ko.locale==='ko','localized_message');
    verify(fallback.fallback&&fallback.locale==='en'&&fallback.text==='Hello SDK','visible_fallback');
    await rejected(()=>api.resolveMessage(catalog,'ko','hello',{}),['invalid_contract'],'missing_placeholder');
  },
  async 'testing-replay'(ctx) {
    const api=ctx.adapters.testing,first=api.createTestClock({seed:12}),second=api.createTestClock({seed:12});ctx.own(()=>first.dispose());ctx.own(()=>second.dispose());
    verify(first.runtime.randomUUID()===second.runtime.randomUUID(),'seed_reproducibility');
    let calls=0;first.runtime.setTimeout(()=>calls++,10);await first.advance(9);verify(calls===0,'clock_before_deadline');await first.advance(1);verify(calls===1&&first.inspect().timers===0,'clock_at_deadline');
    const input={count:2},output={total:4},options={synthetic:true,seed:12,fixtureVersion:1,fixtures:[{id:'run',operation:'command',input,output}]},recorder=api.createTestRecorder(options);
    recorder.record('run',input,output);const trace=recorder.snapshot();verify(!JSON.stringify(trace).includes('total'),'trace_excludes_payload');
    const replay=api.createTestReplay(trace,options);verify(replay.next('run',input).total===4,'pure_replay');replay.assertComplete();
    await rejected(()=>api.createTestReplay(trace,{...options,seed:13}),['version_mismatch'],'trace_seed_binding');
  },
  async diagnostics(ctx) {
    const api=ctx.adapters.diagnostics,session=api.createDiagnosticSession({enabled:true,capacity:2});ctx.own(()=>session.dispose());
    const host=api.profileHost(await ctx.adapters.host(),session);ctx.own(()=>host.dispose());
    await host.activate(fixturePlugin(c=>c.registerCommand({id:'run',title:'Run'},()=>({value:'synthetic-body-never-export'}))));
    for(let i=0;i<5;i++)await host.executeCommand(fixtureManifest.id,'run',{});
    const report=session.snapshot();verify(report.events.length===2&&report.attempted>=6,'bounded_diagnostics');
    verify(!JSON.stringify(report).includes('synthetic-body-never-export'),'diagnostic_payload_exclusion');
    host.dispose();verify(session.snapshot().pending===0,'diagnostic_pending_cleanup');
  },
  async 'development-tools'(ctx) {
    // This operator port supplies a disposable directory and the actual API, never a success flag.
    const fixture=await ctx.adapters.development();ctx.own(()=>fixture.dispose());const {api,directory}=fixture;
    const plan=await api.planPlugin(directory,{template:'configuration'});verify(plan.writes===false&&plan.conflicts.length===0,'generation_dry_run');
    const result=await api.initPlugin(directory,{template:'configuration'});verify(result.generationDigest===plan.generationDigest,'deterministic_generation');
    const doctor=await api.doctorPlugin(directory);
    verify(doctor.checks.some(c=>c.id==='sdk')&&doctor.checks.filter(c=>c.status==='error').every(c=>c.id==='sdk'),'generated_doctor');
    verify((await api.generatePluginContracts(directory,{check:true})).ok,'generated_contract_drift');
    let refused=false;try{await api.initPlugin(directory,{template:'configuration'});}catch{refused=true;}
    verify(refused,'existing_directory_preserved');
    verify((await api.generatePluginContracts(directory,{check:true})).ok,'refused_init_preserves_contracts');
  },
};
