export const projectContains = (root, relative) => root==='' || relative===root || relative.startsWith(root+'/');
function matchSegment(pattern,value){
  let p=0,v=0,star=-1,retry=0;
  while(v<value.length){
    if(p<pattern.length&&(pattern[p]==='?'||pattern[p]===value[v])){p++;v++;}
    else if(pattern[p]==='*'){star=p++;retry=v;}
    else if(star!==-1){p=star+1;v=++retry;}
    else return false;
  }
  while(pattern[p]==='*')p++;
  return p===pattern.length;
}
export function projectMatches(patterns,relative){
  const parts=relative.split('/');
  return patterns.some(pattern=>{
    const tokens=pattern.split('/'),memo=new Map();
    function visit(p,v){const key=p+':'+v;if(memo.has(key))return memo.get(key);const answer=p===tokens.length?v===parts.length:tokens[p]==='**'?visit(p+1,v)||(v<parts.length&&visit(p,v+1)):v<parts.length&&matchSegment(tokens[p],parts[v])&&visit(p+1,v+1);memo.set(key,answer);return answer;}
    return visit(0,0);
  });
}
