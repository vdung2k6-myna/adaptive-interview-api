export class OllamaError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "OllamaError";
    this.statusCode = statusCode;
  }
}

/**
 * A failure of the account's own model endpoint.
 *
 * Separate from `OllamaError` in name and nothing else: it is thrown for a
 * provider this deployment does not run, so a log line that says "OllamaError"
 * sends its reader to the wrong service. It still extends `OllamaError`, because
 * the routes read `instanceof OllamaError` to decide whether the turn's own
 * message may be delivered to the caller.
 */
export class ModelProviderError extends OllamaError {
  constructor(message: string, statusCode: number) {
    super(message, statusCode);
    this.name = "ModelProviderError";
  }
}
