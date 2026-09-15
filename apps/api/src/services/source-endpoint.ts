/**
 * Source endpoint restriction — 06 §6.4, OD-43.
 *
 * `source_connections.endpoint` is set by operators and **the server calls it with credentials
 * attached**. The SSRF checks (save-time shape, pre-call resolution) live in `@mpc/config`
 * (W-087) so notification webhooks are judged by the same code. Re-exported here for existing
 * API callers.
 */
export {
  assertEndpointReachable,
  assertEndpointShape,
  dnsResolver,
  EndpointNotAllowedError,
  isPrivateAddress,
  type HostResolver,
} from "@mpc/config";
