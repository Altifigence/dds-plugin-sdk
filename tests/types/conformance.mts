import {createPluginHost} from '../../src/index.mjs';
import {runConformance,formatConformanceReport,parseConformanceReport,type ConformanceReport} from '../../src/conformance.mjs';
import {createSdkConformanceOptions,createConformanceWorkspace} from '../../src/conformance-node.mjs';
const options=createSdkConformanceOptions();
const report:ConformanceReport=await runConformance(options);
formatConformanceReport(parseConformanceReport(report));
await runConformance({identity:{host:'custom',version:'1.0.0',runtime:'Node',platform:'test'},features:['commands'],requiredFeatures:['commands'],adapters:{host:createPluginHost}});
const fixture=await createConformanceWorkspace();fixture.metrics().requestBytes;await fixture.dispose();
// @ts-expect-error unknown required features cannot silently pass
runConformance({...options,requiredFeatures:['unknown']});
// @ts-expect-error a reported success flag is not a host adapter
runConformance({...options,adapters:{host:()=>({ok:true})}});
