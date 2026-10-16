import type { AppError, ErrorCode } from "../shared";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
}

export class RequestError extends Error {
  readonly detail: AppError;
  usage?: TokenUsage;
  dispatched = false;

  constructor(
    code: ErrorCode,
    message: string,
    retryable = false,
    uncertain = false,
  ) {
    super(message);
    this.name = "RequestError";
    this.detail = {
      code,
      message,
      retryable,
      ...(uncertain ? { uncertain: true } : {}),
    };
  }
}

export function errorDetail(error: unknown): AppError {
  return error instanceof RequestError
    ? error.detail
    : {
        code: "internal",
        message: "扩展暂时无法完成操作，请稍后重试。",
        retryable: true,
      };
}

export function abortError(): RequestError {
  return new RequestError("cancelled", "翻译已停止。");
}

export function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}
