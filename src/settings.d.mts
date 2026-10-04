import type {JsonValue, Disposable, RequestOptions} from './index.mjs';
import type {DataSchema, DisplayMetadata} from './data-schema.mjs';
export type SettingsScope = 'user' | 'workspace';
export interface SettingDefinition {readonly schema: DataSchema; readonly scopes: readonly SettingsScope[]; readonly readOnly?: boolean; readonly display?: DisplayMetadata;}
export interface SettingsDefinition {readonly schemaVersion: 1; readonly pluginId: string; readonly version: number; readonly settings: Readonly<Record<string, SettingDefinition>>;}
export type SettingsValues = Readonly<Record<string, JsonValue>>;
export interface SettingsSnapshot {readonly schemaVersion: 1; readonly pluginId: string; readonly workspaceId: string; readonly definitionVersion: number; readonly revision: number; readonly values: SettingsValues; readonly sources: Readonly<Record<string, 'default' | SettingsScope>>;}
export interface SettingsLayers {readonly user: SettingsValues; readonly workspaces: Readonly<Record<string, SettingsValues>>;}
export interface SettingsState extends SettingsLayers {readonly schemaVersion: 1; readonly pluginId: string; readonly definitionVersion: number; readonly revision: number;}
/** A host-owned port. A plugin only receives the host's scoped read/subscribe API. */
export interface SettingsReadPort {
  read(workspaceId: string, options?: {readonly signal: AbortSignal}): SettingsSnapshot | Promise<SettingsSnapshot>;
  subscribe?(workspaceId: string, callback: (snapshot: SettingsSnapshot) => void): Disposable;
}
export interface SettingsApi {read(options?: RequestOptions): Promise<SettingsSnapshot>; subscribe(callback: (snapshot: SettingsSnapshot) => void): Disposable;}
export interface SettingsStore extends SettingsReadPort, Disposable {
  readonly definition: SettingsDefinition;
  read(workspaceId: string): SettingsSnapshot;
  exportState(): SettingsState;
  update(request: {readonly workspaceId: string; readonly scope: SettingsScope; readonly expectedRevision: number; readonly values?: SettingsValues; readonly reset?: readonly string[]}): SettingsSnapshot;
  subscribe(workspaceId: string, callback: (snapshot: SettingsSnapshot) => void): Disposable;
  migrate(next: SettingsDefinition, migration: (before: SettingsState, options: {readonly signal: AbortSignal; readonly definition: SettingsDefinition}) => SettingsLayers | Promise<SettingsLayers>, options: RequestOptions & {readonly expectedRevision: number}): Promise<SettingsState>;
  inspect(): Readonly<{revision: number; definitionVersion: number; workspaces: number; subscriptions: number; pendingMigrations: number}>;
}
export const SETTINGS_LIMITS: Readonly<{definitionBytes: number; keys: number; layerBytes: number; snapshotBytes: number; stateBytes: number; workspaces: number; subscriptions: number; pendingMigrations: number}>;
export function parseSettingsDefinition(value: unknown): SettingsDefinition;
export function parseSettingsSnapshot(value: unknown): SettingsSnapshot;
export function createSettingsStore(definition: SettingsDefinition, options?: {readonly state?: SettingsState}): SettingsStore;
