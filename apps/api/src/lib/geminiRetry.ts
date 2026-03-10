type RetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  label?: string;
};

const toErrorText = (error: unknown): string => {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
};

const isRetryableGeminiError = (error: unknown): boolean => {
  const text = toErrorText(error).toLowerCase();

  return (
    text.includes('503') ||
    text.includes('service unavailable') ||
    text.includes('currently experiencing high demand') ||
    text.includes('overloaded') ||
    text.includes('resource exhausted') ||
    text.includes('429') ||
    text.includes('rate limit')
  );
};

const sleep = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

export const withGeminiRetry = async <T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> => {
  const maxAttempts = options.maxAttempts ?? Number(process.env.GEMINI_RETRY_MAX_ATTEMPTS ?? 4);
  const baseDelayMs = options.baseDelayMs ?? Number(process.env.GEMINI_RETRY_BASE_DELAY_MS ?? 600);
  const maxDelayMs = options.maxDelayMs ?? Number(process.env.GEMINI_RETRY_MAX_DELAY_MS ?? 4000);
  const label = options.label ?? 'gemini-call';

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (!isRetryableGeminiError(error) || attempt >= maxAttempts) {
        throw error;
      }

      const backoff = Math.min(
        maxDelayMs,
        Math.round(baseDelayMs * 2 ** (attempt - 1)),
      );
      const jitter = Math.floor(Math.random() * 200);
      const delayMs = backoff + jitter;

      console.warn(
        `[${label}] transient Gemini error (attempt ${attempt}/${maxAttempts}): ${toErrorText(
          error,
        )}. Retrying in ${delayMs}ms...`,
      );

      await sleep(delayMs);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`[${label}] failed after retries`);
};
