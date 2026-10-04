// Retry delay doubles for each attempt, capped by the configured ceiling.
export function retryDelay(attempt, config) {
  return Math.min(config.baseDelay * 2 ** attempt, config.ceiling);
}
