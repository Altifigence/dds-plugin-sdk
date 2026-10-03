import { parseManifest } from './contracts.mjs';
import { ErrorCode, PluginSdkError } from './limits.mjs';

export { ErrorCode, LIMITS, PluginSdkError, PROTOCOL_VERSION } from './limits.mjs';
export { parseManifest, parseDocumentSnapshot, parseDiagnosticsRequest, parseDiagnosticsResult, createDiagnosticsResult } from './contracts.mjs';
export { parseCommandDefinition, parseJsonValue, parseLicenseExpression, parseWorkspacePath } from './contracts.mjs';
export { createDiagnosticsRegistry } from './lifecycle.mjs';
export { createLanguageRegistry } from './lifecycle.mjs';
export { LANGUAGE_FEATURES, parseLanguageRequest, parseLanguageResult, createLanguageResult } from './contracts.mjs';
export { createPluginHost } from './host.mjs';

/** Declare an ESM plugin. Activation is performed by a host with explicit grants. */
export function definePlugin(manifest, activate) {
  const valid = parseManifest(manifest);
  if (typeof activate !== 'function') throw new PluginSdkError(ErrorCode.INVALID_CONTRACT, 'Expected an activate function');
  return Object.freeze({manifest: valid, activate});
}
