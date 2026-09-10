/** Presentation only: never limit backend discovery or change session identities. */
export const DEFAULT_SESSION_PAGE_SIZE = 30;
export const MIN_SESSION_PAGE_SIZE = 5;
export const MAX_SESSION_PAGE_SIZE = 50;

export function isSessionPageSize(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
    && value >= MIN_SESSION_PAGE_SIZE && value <= MAX_SESSION_PAGE_SIZE;
}
