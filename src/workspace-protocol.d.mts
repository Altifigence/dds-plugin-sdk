export const WORKSPACE_PROTOCOL_VERSION: 1;
export const WORKSPACE_PATH: '/dds/workspace/v1';
export const WORKSPACE_LIMITS: Readonly<{wireBytes:number;fileBytes:number;jsonBytes:number;depth:number;nodes:number;entries:number;plugins:number;pending:number;receiving:number;connections:number;defaultTimeoutMs:number;maxTimeoutMs:number}>;
export type WorkspaceMethod = 'hello'|'fs.list'|'fs.read'|'fs.capabilities'|'fs.revision'|'fs.readIfChanged'|'fs.write'|'fs.mkdir'|'fs.rename'|'fs.remove'|'plugins.list'|'commands.run'|'request.cancel'|'jobs.capabilities'|'jobs.start'|'jobs.get'|'jobs.events'|'jobs.cancel'|'jobs.artifact'|'artifacts.capabilities'|'artifacts.list'|'artifacts.read'|'history.capabilities'|'history.list'|'history.recover'|'history.retry';
export const WORKSPACE_METHODS: readonly WorkspaceMethod[];
export type WorkspaceErrorCode = 'invalid_request'|'authentication_required'|'permission_denied'|'workspace_mismatch'|'generation_mismatch'|'not_found'|'conflict'|'unsafe_path'|'budget_exceeded'|'cancelled'|'disposed'|'plugin_mismatch'|'provider_failed'|'unsupported'|'unavailable'|'transport_failed';
export const WORKSPACE_ERROR_CODES: readonly WorkspaceErrorCode[];
export class WorkspaceError extends Error { readonly code:WorkspaceErrorCode; constructor(code:WorkspaceErrorCode,message:string); }
export type Json = null|boolean|number|string|readonly Json[]|{readonly [key:string]:Json};
export interface WorkspaceEntry {readonly path:string;readonly name:string;readonly kind:'file'|'directory';readonly size?:number;readonly revision?:string;}
export interface WorkspaceFileCapabilities {readonly protocolVersion:1;readonly revision:boolean;readonly conditionalRead:boolean;}
export interface WorkspaceFileRevision {readonly path:string;readonly revision:string;}
export type WorkspaceConditionalFile = WorkspaceFileRevision & ({readonly notModified:true}|{readonly notModified:false;readonly content:string});
export interface WorkspaceCommand {readonly pluginId:string;readonly id:string;readonly title:string;readonly description?:string;readonly parameters?:readonly {readonly name:string;readonly label:string;readonly type:'string'|'number'|'boolean';readonly required:boolean;readonly choices?:readonly string[]}[];}
export interface WorkspacePlugin {readonly manifest:Readonly<Record<string,Json>>;readonly artifactSha256:string;readonly commands:readonly WorkspaceCommand[];readonly licenseText?:string;}
export interface WorkspaceHello {readonly hostId:string;readonly hostVersion:string;readonly protocolVersion:1;readonly workspace:{readonly id:string;readonly name:string;readonly generation:string};readonly capabilities:{readonly read:true;readonly write:boolean;readonly commands:boolean;readonly manage:boolean};readonly plugins:readonly WorkspacePlugin[];readonly notice:{readonly id:string;readonly version:string;readonly sha256:string;readonly text:string};}
export interface WorkspaceRequest {readonly version:1;readonly requestId:string;readonly method:WorkspaceMethod;readonly workspaceId?:string;readonly generation?:string;readonly params:Readonly<Record<string,Json>>;}
export type WorkspaceReply = {readonly version:1;readonly requestId:string;readonly ok:true;readonly result:Json}|{readonly version:1;readonly requestId:string;readonly ok:false;readonly error:{readonly code:WorkspaceErrorCode;readonly message:string}};
export function workspaceFailure(code:WorkspaceErrorCode,message:string):WorkspaceError;
export function requireText(value:unknown,maximum?:number):string;
export function requireUuid(value:unknown):string;
export function requireSha256(value:unknown):string;
export function requireToken(value:unknown):string;
export function isProtectedWorkspaceComponent(value:unknown):boolean;
export function requireWorkspacePath(value:unknown,allowRoot?:boolean):string;
export function requireFileContent(value:unknown):string;
export function exactObject(value:unknown,required:readonly string[],optional?:readonly string[]):Record<string,unknown>;
export function copyWorkspaceJson(value:unknown,limits?:{maxBytes?:number;maxDepth?:number;maxNodes?:number}):Json;
export function parseWorkspaceRequest(value:unknown):WorkspaceRequest;
export function parseWorkspaceReply(value:unknown,expectedRequestId:string):WorkspaceReply;
export function parseWorkspaceHello(value:unknown):WorkspaceHello;
export function parseWorkspaceMethodResult(method:WorkspaceMethod,value:unknown):Json;
