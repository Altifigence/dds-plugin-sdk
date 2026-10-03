// SPDX-FileCopyrightText: 2026 Altifigence
// SPDX-License-Identifier: Apache-2.0
export type ThemeMode = 'light' | 'dark';
export type ThemeColorKey = 'backdrop' | 'navigation' | 'tool' | 'main' | 'text' | 'muted';
export type ThemeTokenColorKey =
  | 'search' | 'searchText' | 'searchPlaceholder' | 'searchBorder' | 'selection' | 'selectionText'
  | 'tabActive' | 'tabInactive' | 'tabText' | 'rail' | 'panelBorder' | 'popover' | 'focus'
  | 'success' | 'warning' | 'danger' | 'info' | 'aiBall'
  | 'hintsBoxBackground' | 'hintsBoxDetailsBackground' | 'hintsBoxText' | 'hintsBoxDetailsText' | 'hintsBoxMutedText'
  | 'hintsBoxSelectedBackground' | 'hintsBoxSelectedText' | 'hintsBoxHoverBackground' | 'hintsBoxHoverText'
  | 'gdsBackground';
export type ThemeMetricKey = 'panelRadius' | 'controlRadius' | 'popoverRadius' | 'popoverOpacity';
export interface DdsTheme {
  readonly name: string;
  readonly colors: Readonly<{
    light: Readonly<Record<ThemeColorKey, string>>;
    dark: Readonly<Record<ThemeColorKey, string>>;
    tokens?: Readonly<Partial<Record<ThemeMode, Readonly<Partial<Record<ThemeTokenColorKey, string>>>>>>;
    metrics?: Readonly<Partial<Record<ThemeMetricKey, number>>>;
  }>;
}
export const THEME_XML_MAX_BYTES: 65536;
export const THEME_COLOR_KEYS: readonly ThemeColorKey[];
export const THEME_TOKEN_COLOR_KEYS: readonly ThemeTokenColorKey[];
export const THEME_METRICS: Readonly<Record<ThemeMetricKey, Readonly<{
  min: number; max: number; default: number; integer: boolean;
}>>>;
export const THEME_SCHEMA: Readonly<Record<string, unknown>>;
/** Parse a plain object or bounded JSON text and return a canonical frozen copy. */
export function parseTheme(input: unknown): DdsTheme;
/** Serialize a validated theme as a DDS XML version 2 file. */
export function serializeThemeXml(input: unknown): string;
