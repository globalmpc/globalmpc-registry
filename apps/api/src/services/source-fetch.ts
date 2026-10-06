/**
 * Transport layer for source calls.
 *
 * Connections are pinned to the checked addresses and responses are capped. The implementation
 * lives in `@mpc/config` so notification webhooks use the same transport. Re-exported
 * here under the names existing API callers use.
 */
export {
  createPinnedLookup,
  DEFAULT_MAX_RESPONSE_BYTES as MAX_SOURCE_RESPONSE_BYTES,
  pinnedFetch,
  ResponseTooLargeError as SourceResponseTooLargeError,
  type PinnedFetch as SourceFetch,
  type PinnedLookup,
  type PinnedRequestInit as SourceRequestInit,
} from "@mpc/config";
