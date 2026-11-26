/**
 * Error type shared by the connector plugin.
 *
 * The shape mirrors `dsh-global-todo`'s `TodoError`: a machine-readable
 * `reason` plus a human sentence.  HTTP handlers turn it into
 * `{ ok: false, reason, error }`, agent tools into a failed `ok` field, so a
 * caller never has to parse prose to find out what happened.
 */

export class ConnectorError extends Error {
  /**
   * @param {string} reason machine-readable code, e.g. 'invalid-yaml'
   * @param {string} message human sentence
   * @param {Record<string, unknown>} [extra] additional structured detail
   */
  constructor(reason, message, extra = {}) {
    super(message)
    this.name = 'ConnectorError'
    this.reason = reason
    this.extra = extra
  }

  toJSON() {
    return { ok: false, reason: this.reason, error: this.message, ...this.extra }
  }
}

/** Turn any thrown value into a ConnectorError. */
export function asConnectorError(error) {
  if (error instanceof ConnectorError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new ConnectorError('internal', message)
}

/** HTTP status for a reason code. Mirrors the sibling plugin's mapping. */
export function statusForReason(reason) {
  switch (reason) {
    case 'not-found':
      return 404
    case 'payload-too-large':
      return 413
    case 'unauthorized':
      return 401
    case 'forbidden':
      return 403
    case 'method-not-allowed':
      return 405
    case 'invalid-request':
    case 'invalid-yaml':
    case 'invalid-connector':
    case 'invalid-name':
    case 'invalid-body':
      return 422
    case 'conflict':
    case 'revision-conflict':
    case 'lease-held':
      return 409
    case 'hub-unavailable':
      return 502
    case 'store-busy':
    case 'sync-busy':
      return 503
    default:
      return 400
  }
}
