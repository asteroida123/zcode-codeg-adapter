import { safeDetails } from './diagnostics.mjs'

/** Public diagnostics are codes, never backend exception text or payloads. */
export class ProbeError extends Error {
  constructor(code, rpcCode, details) {
    super(code)
    this.name = 'ProbeError'
    this.code = code
    if (Number.isSafeInteger(rpcCode)) this.rpcCode = rpcCode
    this.details = safeDetails(details)
  }
}
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
export function diagnostic(error) {
  // Do not accept an arbitrary object's `code` as printable diagnostic data.
  return error instanceof ProbeError
    ? { code: error.code, ...(error.rpcCode === undefined ? {} : { rpcCode: error.rpcCode }), ...safeDetails(error.details) }
    : { code: 'E_INTERNAL' }
}
