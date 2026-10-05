import {createToolStreamParser} from '/sdk/tool-streams.mjs';
const run=document.querySelector('#run'),cancel=document.querySelector('#cancel'),status=document.querySelector('#status'),events=document.querySelector('#events'),receipt=document.querySelector('#receipt');
const encoder=new TextEncoder(),context={jobId:'browser-job',commandId:'analyze',toolId:'example',toolVersion:'1.0.0'};
const check=(condition,message)=>{if(!condition)throw Error(message);};
function reset(){run.disabled=cancel.disabled=true;events.replaceChildren();receipt.textContent='';status.dataset.state='running';status.textContent='Reading output…';}
function show(event){const row=document.createElement('li');row.textContent=`${event.sequence} · ${event.data.kind} · ${event.data.message??`${event.data.completed}/${event.data.total}`}`;events.append(row);}
async function verify(cancellation){
  reset();let parser;
  try{
    const received=[],controller=new AbortController();
    parser=createToolStreamParser({...context,signal:controller.signal,secrets:['sample-mask-value'],onEvent:async event=>{received.push(event);show(event);await Promise.resolve();}});
    if(cancellation){
      await parser.write(encoder.encode('{"kind":"log","level":"info","message":"First event received"}\n'));controller.abort();
      let stopped=false;try{await parser.write(encoder.encode('must not appear'));}catch(error){stopped=error.code==='CANCELLED';}
      check(stopped&&received.length===1,'Cancellation did not stop the stream');
      receipt.textContent=JSON.stringify({verified:true,cancelled:true,events:received.length},null,2);
    }else{
      const input=[{kind:'log',level:'info',message:'한글 sample-mask-value'},{kind:'progress',completed:1,total:2},{kind:'diagnostic',path:'sample.ts',range:{start:{line:0,character:6},end:{line:0,character:11}},severity:'error',message:'Example type mismatch',code:'TS2322'},'invalid-json-line',{kind:'log',level:'info',message:'Final partial line'}];
      const bytes=encoder.encode(input.map(value=>typeof value==='string'?value:JSON.stringify(value)).join('\n'));
      for(let offset=0;offset<bytes.length;offset+=3)await parser.write(bytes.subarray(offset,offset+3));
      const stats=await parser.finish();
      check(received.length===5&&received[0].data.message==='한글 [redacted]'&&received.at(-1).data.message==='Final partial line'&&stats.unknown===1,'Output contract differs');
      receipt.textContent=JSON.stringify({verified:true,fragmentBytes:3,utf8:true,redacted:true,trailingLine:true,...stats},null,2);
    }
    status.dataset.state='passed';status.textContent=cancellation?'Passed · cancellation stops later events':'Passed · all 5 events verified';
  }catch(error){status.dataset.state='failed';status.textContent='Failed · '+error.message;}
  finally{parser?.dispose();run.disabled=cancel.disabled=false;}
}
run.addEventListener('click',()=>void verify(false));cancel.addEventListener('click',()=>void verify(true));
