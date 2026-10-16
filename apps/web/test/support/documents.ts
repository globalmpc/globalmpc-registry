import type { DocumentNode } from "../../src/lib/api";
export const documentNode = (
  uploadId: string,
  changes: Partial<DocumentNode> = {},
): DocumentNode => ({
  uploadId,
  originalFilename: `${uploadId}.pdf`,
  state: "promoted",
  documentType: "license",
  validUntil: null,
  expired: false,
  daysUntilExpiry: null,
  supersedesUploadId: null,
  supersededByUploadId: null,
  revokedAt: null,
  revocationReason: null,
  openImpactCount: 0,
  version: 3,
  ...changes,
});
