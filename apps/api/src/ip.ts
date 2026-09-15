/**
 * IP address parsing and range checks.
 *
 * The implementation lives in `@mpc/config` (W-087) so the notification worker judges webhook
 * addresses with the same byte-level code. Re-exported here for existing API callers.
 */
export {
  ipToBytes,
  ipv4ToBytes,
  ipv6ToBytes,
  matchesCidr,
  parseCidr,
  type CidrRange,
} from "@mpc/config";
