export type ErrorType =
  "invalid_request_error" | "authentication_error" | "api_error";

/** The error envelope OpenAI-compatible clients already parse. */
export function errorBody(type: ErrorType, code: string, message: string) {
  return { error: { message, type, code } };
}

/** An error raised by this Worker rather than by the Gateway. */
export function errorResponse(
  status: number,
  type: ErrorType,
  code: string,
  message: string,
  headers?: Record<string, string>,
): Response {
  return Response.json(errorBody(type, code, message), { status, headers });
}
