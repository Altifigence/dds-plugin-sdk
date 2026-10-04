// Private capability registry: query ports reuse an operator-created watcher.
const contexts=new WeakMap();
export function registerNodeProject(port,context){contexts.set(port,context);}
export function nodeProjectContext(port){return contexts.get(port);}
