/** Shared demo pacing helper — the import and stream routes both delay per
 * tick so the streamed patches are visible in the browser. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
