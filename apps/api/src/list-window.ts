import { badRequest } from "./errors.js";

/**
 * Capped lists.
 *
 * A list that stops at a fixed row count must say so. Callers fetch `limit + 1` rows: the extra
 * row is never returned, it only answers "is there more". Counting everything to answer that
 * would scan the whole set on every request.
 */
export function capRows<T>(
  rows: readonly T[],
  limit: number,
): { items: T[]; truncated: boolean; limit: number } {
  return { items: rows.slice(0, limit), truncated: rows.length > limit, limit };
}

/**
 * Keyset cursor over (timestamp, uuid).
 *
 * **The timestamp stays text end to end.** postgres.js turns a `timestamptz` into a JS Date,
 * which holds milliseconds; the column holds microseconds. A cursor built from a Date points
 * up to 999µs before the real row, and every row in that gap is skipped. So the SQL renders the
 * value as text with six fractional digits, and the query casts the text back.
 *
 * base64url is not secrecy. It marks the value as ours, to be sent back unchanged — once
 * clients assemble sort keys, the sort can never change.
 */
export interface KeysetCursor {
  readonly at: string;
  readonly id: string;
}

/** SQL expression that renders a timestamptz column in the cursor's text form. */
export const CURSOR_TIME_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

const CURSOR_SHAPE =
  /^(?<at>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|(?<id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function encodeKeysetCursor(cursor: KeysetCursor): string {
  return Buffer.from(`${cursor.at}|${cursor.id}`, "utf8").toString("base64url");
}

export function decodeKeysetCursor(value: string): KeysetCursor {
  const matched = CURSOR_SHAPE.exec(Buffer.from(value, "base64url").toString("utf8"));
  if (!matched || Number.isNaN(new Date(matched.groups!["at"]!).getTime())) {
    // Not silently reset to the first page: the client would page forever without ever
    // believing it reached the end.
    throw badRequest("INVALID_CURSOR", "Cursor was not issued by this list");
  }
  return { at: matched.groups!["at"]!, id: matched.groups!["id"]! };
}
