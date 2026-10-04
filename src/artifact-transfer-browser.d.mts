import type {ArtifactSink} from './artifact-transfer.mjs';
/** Structural types keep browser consumers independent of nonstandard DOM declarations. */
export interface BrowserFileHandle {
  readonly kind:'file';
  queryPermission?(options:{mode:'readwrite'}):Promise<'granted'|'denied'|'prompt'>;
  isSameEntry?(other:BrowserFileHandle):Promise<boolean>;
  getFile():Promise<{readonly size:number;readonly lastModified:number;slice(start:number,end:number):{arrayBuffer():Promise<ArrayBuffer>}}>;
  createWritable(options:{keepExistingData:boolean}):Promise<{write(data:Uint8Array):Promise<void>;close():Promise<void>;abort():Promise<void>}>;
}
export interface BrowserDirectoryHandle {readonly kind:'directory';getFileHandle(name:string,options:{create:boolean}):Promise<BrowserFileHandle>;}
export interface BrowserSinkOptions {readonly overwrite:boolean;}
export function createBrowserFileSink(handle:BrowserFileHandle,options:BrowserSinkOptions):ArtifactSink;
export function createOpfsFileSink(directory:BrowserDirectoryHandle,name:string,options:BrowserSinkOptions):Promise<ArtifactSink>;
export function getBrowserArtifactStorageSupport():Readonly<{secureContext:boolean;filePicker:boolean;originPrivate:boolean;writableStream:boolean;syncAccess:boolean}>;
