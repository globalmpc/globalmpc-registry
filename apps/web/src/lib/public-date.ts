/** Public dates use UTC calendar days; precise timestamps remain in time/title attributes. */
export function publicDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toISOString().slice(0, 10);
}
