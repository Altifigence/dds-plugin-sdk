import assert from 'node:assert/strict';
import {runConformance,formatConformanceReport} from '@altifigence/dds-plugin-sdk/conformance';
import {createSdkConformanceOptions} from '@altifigence/dds-plugin-sdk/conformance-node';
const report=await runConformance(createSdkConformanceOptions());
console.log(process.argv.includes('--json')?JSON.stringify(report):formatConformanceReport(report));
assert.equal(report.ok,true,'See the failed feature/check in the conformance report');
