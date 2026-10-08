export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }

  static notFound(message: string): HttpError {
    return new HttpError(404, message);
  }

  static badRequest(message: string, details?: unknown): HttpError {
    return new HttpError(400, message, details);
  }

  static conflict(message: string): HttpError {
    return new HttpError(409, message);
  }

  static badGateway(message: string): HttpError {
    return new HttpError(502, message);
  }
}
