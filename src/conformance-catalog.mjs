import {freezeConfiguration} from './configuration-values.mjs';

/** Case IDs and fixture paths are public, versioned review targets. */
export const CONFORMANCE_CASES = freezeConfiguration([
  {id:'commands',since:'0.2',port:'host',required:true,fixture:'examples/publishable-plugin/plugin.mjs'},
  {id:'permissions',since:'0.2',port:'host',required:true,fixture:'examples/user-workspace/plugin.mjs'},
  {id:'cancellation',since:'0.2',port:'host',required:true,fixture:'examples/development-tools/run.mjs'},
  {id:'language',since:'0.11',port:'host',required:false,fixture:'examples/language-assistance/run.mjs'},
  {id:'language-editing',since:'0.11',port:'host',required:false,fixture:'examples/language-editing/run.mjs'},
  {id:'language-display',since:'0.11',port:'host',required:false,fixture:'examples/language-display/run.mjs'},
  {id:'settings',since:'0.12',port:'settings',required:false,fixture:'examples/configuration/run.mjs'},
  {id:'jobs',since:'0.4',port:'host',required:false,fixture:'examples/command-jobs/run.mjs'},
  {id:'storage-history',since:'0.8',port:'host',required:false,fixture:'examples/durable-jobs/run.mjs'},
  {id:'files',since:'0.6',port:'workspace',required:false,fixture:'examples/project-session/run.mjs'},
  {id:'projects',since:'0.9',port:'workspace',required:false,fixture:'examples/project-tools/run.mjs'},
  {id:'artifacts',since:'0.8',port:'workspace',required:false,fixture:'examples/stored-artifacts/run.mjs'},
  {id:'uploads-transfers',since:'0.10',port:'workspace',required:false,fixture:'examples/transfer-queue/run.mjs'},
  {id:'workspace-edits',since:'0.11',port:'workspace',required:false,fixture:'examples/workspace-edits/run.mjs'},
  {id:'localization',since:'0.12',port:'localization',required:false,fixture:'examples/configuration/run.mjs'},
  {id:'testing-replay',since:'0.13',port:'testing',required:false,fixture:'examples/development-tools/run.mjs'},
  {id:'diagnostics',since:'0.13',port:'diagnostics',required:false,fixture:'examples/development-tools/run.mjs'},
  {id:'development-tools',since:'0.13',port:'development',required:false,fixture:'examples/conformance/run.mjs'},
]);
export const CONFORMANCE_FEATURES = Object.freeze(CONFORMANCE_CASES.map(value=>value.id));
