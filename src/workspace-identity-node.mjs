import {createHash} from 'node:crypto';
export const nodeWorkspaceIdentity = (root, stat) => createHash('sha256').update(JSON.stringify({root, dev: String(stat.dev), ino: String(stat.ino)})).digest('hex');
