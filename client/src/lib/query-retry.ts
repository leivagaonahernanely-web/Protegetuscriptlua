import { TRPCClientError } from "@trpc/client";

export function isTransientNetworkError(error: unknown) {
  if (error instanceof TypeError) return /failed to fetch|network|load failed/i.test(error.message);
  return error instanceof TRPCClientError && /failed to fetch|network/i.test(error.message);
}

export function shouldRetryQuery(failureCount: number, error: unknown) {
  return isTransientNetworkError(error) && failureCount < 2;
}
