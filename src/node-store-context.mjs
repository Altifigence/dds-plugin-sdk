const stores = new WeakMap();
export function registerNodeStore(store, context) {stores.set(store, context);}
export function nodeStoreContext(store) {return stores.get(store);}
