// Public redistributable fixture; the operator pins this script and the Node executable.
if(process.argv.includes('--version')){process.stdout.write('DDS synthetic tool 1.0.0\n');process.exit(0);}
const mode=process.argv[2]??'normal';
if(mode==='slow'){setInterval(()=>process.stdout.write(JSON.stringify({kind:'log',level:'info',message:'working'})+'\n'),25);}
else if(mode==='crash'){process.stdout.write(JSON.stringify({kind:'log',level:'info',message:'before crash'})+'\n');process.exitCode=7;}
else if(mode==='long'){process.stdout.write('x'.repeat(20_000));}
else if(mode==='flood'){for(let i=0;i<5000;i++)process.stdout.write(JSON.stringify({kind:'log',level:'info',message:'bounded event'})+'\n');}
else {
  const bytes=Buffer.from(JSON.stringify({kind:'log',level:'info',message:'한글 output'})+'\n');
  const split=bytes.indexOf(Buffer.from('한'))+1;process.stdout.write(bytes.subarray(0,split));
  await new Promise(r=>setTimeout(r,5));process.stdout.write(bytes.subarray(split));
  process.stdout.write(JSON.stringify({kind:'progress',completed:1,total:1,message:'done'})+'\n');
  process.stdout.write(JSON.stringify({kind:'diagnostic',path:'sample.ts',range:{start:{line:0,character:2},end:{line:0,character:3}},severity:'warning',message:'Synthetic warning',source:'synthetic'})+'\n');
  process.stderr.write(JSON.stringify({kind:'log',level:'error',message:'mask-demo-value '+process.cwd()})+'\n');
  process.stdout.write(JSON.stringify({kind:'log',level:'info',message:'last partial line'}));
}
