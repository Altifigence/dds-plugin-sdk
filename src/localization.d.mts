import type {CommandDefinition, PluginManifest} from './index.mjs';
import type {DisplayMetadata} from './data-schema.mjs';
import type {SettingsDefinition} from './settings.mjs';
import type {DdsTheme} from './themes.mjs';
export const LOCALIZATION_LIMITS: Readonly<{catalogBytes: number; locales: number; keys: number; messageCharacters: number; formattedCharacters: number; placeholders: number; surfaces: number}>;
export interface LocaleCatalog {readonly schemaVersion: 1; readonly defaultLocale: string; readonly messages: Readonly<Record<string, Readonly<Record<string, string>>>>; readonly fallbacks?: Readonly<Record<string, readonly string[]>>;}
export type MessageArguments = Readonly<Record<string, string | number | boolean>>;
export interface LocalizedMessage {readonly key: string; readonly text: string; readonly locale: string; readonly requestedLocale: string; readonly fallback: boolean; readonly direction: 'ltr' | 'rtl';}
export function canonicalLocale(input: string): string;
export function messagePlaceholders(input: string): readonly string[];
export function parseLocaleCatalog(input: unknown): LocaleCatalog;
export function negotiateLocale(catalog: LocaleCatalog, requested: string | readonly string[]): string;
export function localeDirection(locale: string): 'ltr' | 'rtl';
export function resolveMessage(catalog: LocaleCatalog, locale: string, key: string, args?: MessageArguments): LocalizedMessage;
export function formatMessage(catalog: LocaleCatalog, locale: string, key: string, args?: MessageArguments): string;
export function formatLocaleNumber(locale: string, value: number, options?: {readonly style?: 'decimal' | 'percent'; readonly minimumFractionDigits?: number; readonly maximumFractionDigits?: number; readonly useGrouping?: boolean}): string;
export function formatLocaleDate(locale: string, epochMs: number, options?: {readonly dateStyle?: 'full' | 'long' | 'medium' | 'short'; readonly timeStyle?: 'full' | 'long' | 'medium' | 'short'; readonly timeZone?: string}): string;
export function selectLocalePlural(locale: string, value: number, options?: {readonly type?: 'cardinal' | 'ordinal'}): Intl.LDMLPluralRule;
export function localizeDisplay(catalog: LocaleCatalog, locale: string, display: DisplayMetadata): DisplayMetadata;
export function validateLocalizedSurfaces(catalog: LocaleCatalog, surfaces: {readonly manifest?: PluginManifest; readonly commands?: readonly CommandDefinition[]; readonly settings?: SettingsDefinition; readonly themes?: readonly {readonly theme: DdsTheme; readonly display: DisplayMetadata}[]}): Readonly<{keys: readonly string[]; missingTranslations: readonly {readonly locale: string; readonly key: string}[]; surfaces: number}>;
