export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (msg = 'Bad request', code) => new HttpError(400, msg, code);
export const unauthorized = (msg = 'Unauthorized', code) => new HttpError(401, msg, code);
export const forbidden = (msg = 'Forbidden', code) => new HttpError(403, msg, code);
export const notFound = (msg = 'Not found') => new HttpError(404, msg);
export const conflict = (msg, code) => new HttpError(409, msg, code);

// Parses req data with a zod schema, throwing a 400 on failure.
export function parse(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw badRequest(result.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '), 'VALIDATION');
  }
  return result.data;
}
