import { z } from "zod";

/** Decimal strings preserve precision; binary floating point is never an input format. */
export const structuredClaimValues = z.record(
  z.string().regex(/^[a-z][a-z0-9_]{0,99}$/),
  z.union([z.string().max(4000), z.boolean()]),
).refine((value) => Object.keys(value).length <= 50, "At most 50 declared fields");

export const structuredClaimInput = {
  catalogEntryId: z.string().uuid().nullable().optional(),
  structuredValues: structuredClaimValues.nullable().optional(),
  documentUploadIds: z.array(z.string().uuid()).max(20).optional(),
};
export const structuredClaimView = {
  catalogEntryId: z.string().uuid().nullable(),
  catalogVersion: z.number().int().positive().nullable(),
  structuredValues: structuredClaimValues.nullable(),
  documentUploadIds: z.array(z.string().uuid()),
};
