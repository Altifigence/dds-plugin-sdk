// A real child process used as a deterministic, preinstalled-tool adapter example.
// Replace its fixed executable/arguments in server.mjs with an operator-approved tool.
let bytes=0;const chunks=[];
for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>262144)throw new Error('Input limit exceeded');chunks.push(chunk);}
const {content}=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
if(typeof content!=='string')throw new Error('Expected file text');
process.stdout.write(JSON.stringify({tool:'module-counter',modules:(content.match(/\bmodule\b/g)??[]).length,bytes:Buffer.byteLength(content),pid:process.pid}));
