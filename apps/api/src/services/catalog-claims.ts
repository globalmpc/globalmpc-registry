import type postgres from "postgres";
import { claimTypeDefinition, structuredClaimValues } from "@mpc/api-contract";
import { unprocessable } from "../errors.js";

type Values = Record<string, string | boolean>;
export interface CatalogClaimInput {
  catalogEntryId?: string | null | undefined;
  structuredValues?: Values | null | undefined;
  documentUploadIds?: string[] | undefined;
  sourceReceiptId?: string | null | undefined;
}
export interface CatalogClaimContent {
  catalogEntryId: string | null;
  catalogVersion: number | null;
  structuredValues: Values | null;
  documentUploadIds: string[];
}

export function validateCatalogValues(definition: unknown, values: Values): void {
  const schema = claimTypeDefinition.parse(definition);
  if (!structuredClaimValues.safeParse(values).success) {
    throw unprocessable("CLAIM_FIELDS_INVALID", "Structured values exceed their allowed bounds");
  }
  const declared = new Set(schema.fields.map((field) => field.key));
  if (Object.keys(values).some((key) => !declared.has(key))) {
    throw unprocessable("CLAIM_FIELDS_INVALID", "Only declared catalog fields are accepted");
  }
  for (const field of schema.fields) {
    const value = Object.hasOwn(values, field.key) ? values[field.key] : undefined;
    if (value === undefined) {
      if (field.required) throw unprocessable("CLAIM_FIELDS_INVALID", `Required field: ${field.key}`);
      continue;
    }
    let valid = false;
    if (field.type === "boolean") valid = typeof value === "boolean";
    if (field.type === "string") valid = typeof value === "string" && value.trim().length > 0;
    if (field.type === "number") valid = typeof value === "string" && /^-?(0|[1-9][0-9]{0,77})(\.[0-9]{1,38})?$/.test(value);
    if (field.type === "date" && typeof value === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) && !value.startsWith("0000-")) {
      const date = new Date(`${value}T00:00:00.000Z`);
      valid = Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
    }
    if (!valid) throw unprocessable("CLAIM_FIELDS_INVALID", `Invalid ${field.type} field: ${field.key}`);
  }
}

export async function resolveCatalogClaim(
  tx: postgres.TransactionSql, projectId: string, claimType: string, input: CatalogClaimInput,
): Promise<CatalogClaimContent> {
  const catalogEntryId = input.catalogEntryId ?? null;
  const values = input.structuredValues ?? null;
  if ((catalogEntryId === null) !== (values === null)) {
    throw unprocessable("CLAIM_CATALOG_REQUIRED", "Catalog entry and structured values must be provided together");
  }
  let catalogVersion: number | null = null;
  if (catalogEntryId !== null && values !== null) {
    const [catalog] = await tx<{ catalog_version: number; definition: unknown }[]>`
      SELECT catalog_version, definition FROM core.claim_types
      WHERE id = ${catalogEntryId} AND claim_type = ${claimType} AND effective_from <= now()
    `;
    if (!catalog) throw unprocessable("CLAIM_CATALOG_UNAVAILABLE", "Select an approved, effective catalog entry for this claim type");
    validateCatalogValues(catalog.definition, values);
    catalogVersion = catalog.catalog_version;
  }
  if (catalogEntryId !== null && input.sourceReceiptId) {
    const [receipt] = await tx<{ id: string }[]>`
      SELECT id FROM core.source_receipts WHERE id = ${input.sourceReceiptId} AND project_id = ${projectId}
    `;
    if (!receipt) throw unprocessable("CLAIM_RECEIPT_UNAVAILABLE", "The source receipt must belong to this project");
  }
  const documentUploadIds = [...new Set(input.documentUploadIds ?? [])];
  if (documentUploadIds.length > 0) {
    const uploads = await tx<{ id: string }[]>`
      SELECT id FROM core.object_uploads
      WHERE id = ANY(${documentUploadIds}::uuid[]) AND project_id = ${projectId}
        AND state::text IN ('scanned_clean', 'promoted') AND revoked_at IS NULL
      FOR SHARE
    `;
    if (uploads.length !== documentUploadIds.length) throw unprocessable("CLAIM_DOCUMENT_UNAVAILABLE", "Every document must be an active, scanned upload of this project");
  }
  return { catalogEntryId, catalogVersion, structuredValues: values, documentUploadIds };
}
