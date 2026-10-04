import {workspaceFailure} from './workspace-values.mjs';

// SHA-256 (FIPS 180-4). Only one 64-byte block and one 64-word schedule are retained.
const K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);
const rotate = (x,n) => (x>>>n)|(x<<(32-n));
const checkpoints = new WeakMap();
// Private checkpoint support for persistent sinks; the public digest() remains finalizing.
export function snapshotSha256(hash) {
  const checkpoint=checkpoints.get(hash);
  if(!checkpoint)throw workspaceFailure('invalid_request','Unknown incremental hash');
  return checkpoint();
}
export function createIncrementalSha256() {
  const state = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const block = new Uint8Array(64), words = new Uint32Array(64);
  let used=0,total=0,finished=false;
  function compress(bytes,start=0) {
    for(let i=0;i<16;i++){const p=start+i*4;words[i]=((bytes[p]<<24)|(bytes[p+1]<<16)|(bytes[p+2]<<8)|bytes[p+3])>>>0;}
    for(let i=16;i<64;i++) {const x=words[i-15],y=words[i-2];words[i]=(words[i-16]+(rotate(x,7)^rotate(x,18)^(x>>>3))+words[i-7]+(rotate(y,17)^rotate(y,19)^(y>>>10)))>>>0;}
    let a=state[0],b=state[1],c=state[2],d=state[3],e=state[4],f=state[5],g=state[6],h=state[7];
    for(let i=0;i<64;i++) {
      const t1=(h+(rotate(e,6)^rotate(e,11)^rotate(e,25))+((e&f)^(~e&g))+K[i]+words[i])>>>0;
      const t2=((rotate(a,2)^rotate(a,13)^rotate(a,22))+((a&b)^(a&c)^(b&c)))>>>0;
      h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
    }
    state[0]=(state[0]+a)>>>0;state[1]=(state[1]+b)>>>0;state[2]=(state[2]+c)>>>0;state[3]=(state[3]+d)>>>0;
    state[4]=(state[4]+e)>>>0;state[5]=(state[5]+f)>>>0;state[6]=(state[6]+g)>>>0;state[7]=(state[7]+h)>>>0;
  }
  const api=Object.freeze({
    get byteLength(){return total;},
    update(bytes) {
      if(finished)throw workspaceFailure('disposed','SHA-256 has already been finalized');
      if(!(bytes instanceof Uint8Array)||typeof SharedArrayBuffer!=='undefined'&&bytes.buffer instanceof SharedArrayBuffer)throw workspaceFailure('invalid_request','SHA-256 requires non-shared bytes');
      if(!Number.isSafeInteger(total+bytes.length)||total+bytes.length>1_073_741_824)throw workspaceFailure('budget_exceeded','SHA-256 input exceeds the artifact limit');
      total+=bytes.length;let offset=0;
      if(used){const count=Math.min(64-used,bytes.length);block.set(bytes.subarray(0,count),used);used+=count;offset=count;if(used===64){compress(block);used=0;}}
      while(offset+64<=bytes.length){compress(bytes,offset);offset+=64;}
      if(offset<bytes.length){block.set(bytes.subarray(offset));used=bytes.length-offset;}
      return api;
    },
    digest() {
      if(finished)throw workspaceFailure('disposed','SHA-256 has already been finalized');
      finished=true;block[used++]=0x80;block.fill(0,used);
      if(used>56){compress(block);block.fill(0);}
      const view=new DataView(block.buffer);view.setUint32(56,Math.floor(total/0x20000000),false);view.setUint32(60,(total*8)>>>0,false);compress(block);
      const result=Array.from(state,value=>value.toString(16).padStart(8,'0')).join('');block.fill(0);words.fill(0);state.fill(0);return result;
    },
  });
  checkpoints.set(api,()=>{
    if(finished)throw workspaceFailure('disposed','SHA-256 has already been finalized');
    const savedState=state.slice(),savedBlock=block.slice(),savedUsed=used;
    try{return api.digest();}finally{state.set(savedState);block.set(savedBlock);used=savedUsed;finished=false;}
  });
  return api;
}
