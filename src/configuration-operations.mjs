import {ErrorCode, PluginSdkError} from './limits.mjs';
import {configurationObject, configurationInteger} from './configuration-values.mjs';
import {hostRuntime} from './host-runtime.mjs';

export const configurationError = code => new PluginSdkError(code, 'Configuration operation failed');
export function configurationOptions(options = {}) {
  configurationObject(options, [], ['signal', 'timeoutMs']);
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw configurationError(ErrorCode.INVALID_CONTRACT);
  configurationInteger(options.timeoutMs ?? 5000, 30_000, 1);
  return {signal: options.signal, timeoutMs: options.timeoutMs ?? 5000};
}

/** Cancellation ends the caller's wait; ignored cancellation still occupies a slot. */
export function createConfigurationOperations(maximum,runtimeInput) {
  const runtime=hostRuntime(runtimeInput);
  const pending = new Map(); let closed = false;
  const abort = (controller, code) => {if (!controller.signal.aborted) controller.abort(configurationError(code));};
  return Object.freeze({
    async run(operation, options = {}, {tag, expiresIn} = {}) {
      if (closed) throw configurationError(ErrorCode.DISPOSED);
      const {signal, timeoutMs} = configurationOptions(options);
      if (signal?.aborted) throw configurationError(ErrorCode.CANCELLED);
      if (expiresIn !== undefined && expiresIn <= 0) throw configurationError(ErrorCode.PERMISSION_DENIED);
      if (pending.size >= maximum) throw configurationError(ErrorCode.BUDGET_EXCEEDED);
      const controller = new AbortController(); pending.set(controller, tag);
      const callerAbort = () => abort(controller, ErrorCode.CANCELLED);
      signal?.addEventListener('abort', callerAbort, {once: true});
      let rejectAbort;
      const aborted = new Promise((_, reject) => {rejectAbort = () => reject(controller.signal.reason); controller.signal.addEventListener('abort', rejectAbort, {once: true});});
      const expiryFirst = expiresIn !== undefined && expiresIn <= timeoutMs;
      const timer = runtime.setTimeout(() => abort(controller, expiryFirst ? ErrorCode.PERMISSION_DENIED : ErrorCode.BUDGET_EXCEEDED), Math.min(timeoutMs, expiresIn ?? timeoutMs));
      const actual = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason;
        return operation(controller.signal);
      }).then(result => {if (controller.signal.aborted) throw controller.signal.reason; return result;}).finally(() => pending.delete(controller));
      try {return await Promise.race([actual, aborted]);}
      finally {runtime.clearTimeout(timer); signal?.removeEventListener('abort', callerAbort); controller.signal.removeEventListener('abort', rejectAbort);}
    },
    abort(tag, code = ErrorCode.PERMISSION_DENIED) {for (const [controller, owner] of pending) if (owner === tag) abort(controller, code);},
    get pending() {return pending.size;},
    dispose() {closed = true; for (const controller of pending.keys()) abort(controller, ErrorCode.DISPOSED);},
  });
}
