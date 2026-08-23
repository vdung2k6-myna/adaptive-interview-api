export class OllamaError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "OllamaError";
    this.statusCode = statusCode;
  }
}
