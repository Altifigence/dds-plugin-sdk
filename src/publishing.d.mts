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
export interface VerifiedPluginArchive extends PackageReport {
  readonly artifact: { readonly filename: string; readonly size: number; readonly sha256: string };
  /** True only when the caller supplied a matching expectedSha256. Not publisher authentication. */
  readonly checksumPinned: boolean;
}
/**
 * Node.js only. Verifies a DDS 0.3.x CLI archive and its external release metadata
 * without extracting or executing it. The receipt describes the bytes read now;
 * it does not establish publisher identity, code safety or installation consent.
 */
export function verifyPluginArchive(archivePath: string, options?: {
  /** Defaults to archivePath + '.release.json'. */
  readonly metadataPath?: string;
  /** A lowercase SHA-256 obtained independently from a trusted release channel. */
  readonly expectedSha256?: string;
}): Promise<VerifiedPluginArchive>;
/** Returns copies of verified bytes. Later mutation does not alter the receipt's subject. */
export function inspectPluginArchiveBytes(archive: Uint8Array, metadata: unknown, options?: {readonly expectedSha256?: string}): {
  readonly receipt: VerifiedPluginArchive;
  readonly manifest: import('./index.mjs').PluginManifest;
  readonly files: readonly {readonly path: string; readonly data: Uint8Array}[];
};
