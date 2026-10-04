// Only failures classified by the HTTP client may trigger automatic chunk retry.
// Codes alone are insufficient: a quota failure is not a request timeout.
const transient = new WeakSet();
export function markTransferTransient(error) { transient.add(error); return error; }
export function isTransferTransient(error) { return error !== null && typeof error === 'object' && transient.has(error); }
