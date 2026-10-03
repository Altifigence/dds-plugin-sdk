export const PROTOCOL_VERSION = 1;

export const LIMITS = Object.freeze({
  manifestBytes: 16_384,
  requestBytes: 1_600_000,
  resultBytes: 1_600_000,
  documentBytes: 262_144,
  maxDiagnostics: 500,
  messageLength: 2_048,
  maxRegistrations: 32,
  maxPendingRequests: 64,
  defaultTimeoutMs: 5_000,
  maxTimeoutMs: 30_000,
});

export const ErrorCode = Object.freeze({
  INVALID_CONTRACT: 'invalid_contract',
  PERMISSION_DENIED: 'permission_denied',
  UNSUPPORTED_HOST: 'unsupported_host',
  VERSION_MISMATCH: 'version_mismatch',
  CANCELLED: 'cancelled',
  STALE_SNAPSHOT: 'stale_snapshot',
  BUDGET_EXCEEDED: 'budget_exceeded',
  DISPOSED: 'disposed',
  PROVIDER_FAILED: 'provider_failed',
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
});

export class PluginSdkError extends Error {
  constructor(code, message) {
    super(String(message).slice(0, LIMITS.messageLength));
    this.name = 'PluginSdkError';
    this.code = Object.values(ErrorCode).includes(code) ? code : ErrorCode.INVALID_CONTRACT;
  }
}
