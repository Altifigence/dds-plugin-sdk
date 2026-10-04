// Concrete Node workspaces share their already-validated root with optional ports.
// This registry is not exported by the package and never accepts a caller root.
const contexts = new WeakMap();
export function registerNodeWorkspace(workspace, context) { contexts.set(workspace, context); }
export function nodeWorkspaceContext(workspace) { return contexts.get(workspace); }
