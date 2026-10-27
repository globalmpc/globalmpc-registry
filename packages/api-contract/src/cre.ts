import { z } from "zod";
import { hex32, walletAddress } from "./common.js";

const positiveUint64 = z.string().regex(/^[1-9][0-9]{0,19}$/).refine(value => /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n);
export const createCreReportRequest = z.object({
  publicKey: z.string().min(1).max(200),
  chainId: z.string().regex(/^[1-9][0-9]{0,77}$/).refine(value => /^[1-9][0-9]{0,77}$/.test(value) && BigInt(value) < (1n << 256n)),
  receiver: walletAddress.refine(value => value !== `0x${"0".repeat(40)}`, "Receiver must be nonzero"),
  ttlSeconds: positiveUint64.refine(value => /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 3600n),
}).strict();

/** Flat ABI report. Transport freshness is separate from the observed Registry status. */
export const creReport = z.object({
  chainId: createCreReportRequest.shape.chainId,
  receiver: createCreReportRequest.shape.receiver,
  recordId: hex32,
  registryVersion: positiveUint64,
  contentHash: hex32,
  observedAt: positiveUint64.describe("Registry health observation time, as Unix seconds"),
  validUntil: positiveUint64.describe("Transport freshness deadline, not a licence or professional-approval expiry"),
  sequence: positiveUint64,
  status: z.number().int().min(1).max(5).describe("1=current observation, 2=needs re-review, 3=revoked, 4=reserved, 5=unavailable; not a readiness approval"),
}).strict();
