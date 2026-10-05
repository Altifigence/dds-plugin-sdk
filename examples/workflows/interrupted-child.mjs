// A disposable example child. The parent owns its lifetime and kills it after a durable checkpoint.
import {createNodeWorkflowStore} from '@altifigence/dds-plugin-sdk/workflows-node';
import {prepareWorkflowPlan,createWorkflowRunner} from '@altifigence/dds-plugin-sdk/workflows';
import {commands,recoveryDefinition} from './fixture.mjs';
const options=JSON.parse(process.argv[2]),store=await createNodeWorkflowStore(options);
const plan=prepareWorkflowPlan(recoveryDefinition,commands);
const hold=setInterval(()=>{},1000);
try{
  await createWorkflowRunner({commands,store,authorize:()=>true,execute:async(step,_,__,context)=>{
    if(step.id==='right'){process.send({ready:true,attemptId:context.attemptId});await new Promise(()=>{});}
    return {output:{value:10}};
  }}).run(plan,{approval:{approved:true,planSha256:plan.sha256}});
}finally{clearInterval(hold);await store.close();}
