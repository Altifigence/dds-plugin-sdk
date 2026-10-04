import type {ConformanceOptions,ConformanceWorkspace} from './conformance.mjs';
export interface NodeConformanceWorkspace extends ConformanceWorkspace {failNextRequest(kind:'disconnect'|'malformed'):void;metrics():Readonly<{requests:number;requestBytes:number;responseBytes:number;fixtureWriteBytes:number}>;}
/** Creates only synthetic temporary files and a loopback HTTP server; does not start external tools. */
export function createConformanceWorkspace(options?:{readonly signal?:AbortSignal}):Promise<NodeConformanceWorkspace>;
export function createSdkConformanceOptions():ConformanceOptions;
