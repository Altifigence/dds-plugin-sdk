export interface PackageFile { readonly path: string; readonly size: number; readonly sha256: string; }
export interface PackageReport {
  readonly schemaVersion: 1;
  readonly pluginId: string; readonly pluginVersion: string; readonly publisher: string;
  readonly license: string; readonly sourceVisibility: 'open' | 'closed';
  readonly manifestSha256: string; readonly disclosureSha256: string;
  readonly unpackedSize: number; readonly files: readonly PackageFile[];
}
export interface PackedPlugin extends PackageReport {
  readonly artifact: { readonly filename: string; readonly size: number; readonly sha256: string };
  readonly archivePath: string; readonly metadataPath: string;
}
/** Node.js only. Does not import the plugin, run scripts, upload or record consent. */
export function validatePluginPackage(directory: string): Promise<PackageReport>;
/** Node.js only. Does not overwrite an existing archive or metadata file. */
export function packPlugin(directory: string, options: {readonly out: string}): Promise<PackedPlugin>;
