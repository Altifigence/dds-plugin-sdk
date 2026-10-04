import type {DisplayMetadata} from './data-schema.mjs';
import type {ThemeMode} from './themes.mjs';
export function normalizeShortcut(input: string): string;
export function inspectAccessibility(input: readonly {readonly id: string; readonly display: DisplayMetadata}[]): Readonly<{issues: readonly {readonly id: string; readonly code: 'missing_name'}[]; conflicts: readonly {readonly shortcut: string; readonly ids: readonly string[]}[]}>;
export function contrastRatio(foreground: string, background: string): number;
export interface ThemeContrastCheck {readonly mode: ThemeMode; readonly foreground: string; readonly background: string; readonly ratio: number; readonly minimum: number; readonly passes: boolean;}
export function inspectThemeContrast(input: unknown, options?: {readonly minimum?: number}): Readonly<{checks: readonly ThemeContrastCheck[]; failures: number}>;
