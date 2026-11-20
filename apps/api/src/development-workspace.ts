import { ROUTES, toFastifyPath } from "@mpc/api-contract";

// Explicit operations for Google sessions in the develop testnet workspace.
const developmentOperations = new Set([
  "createProject", "listProjects", "getProject", "updateProject",
  "listRegistrationRequests", "createRegistrationRequest", "getClaimDetail",
  "listProjectFacts", "listProjectParties", "listStakeholderEvents",
  "getJurisdictionProfile", "listClaimTypes", "recordEvidenceLedger",
  "listOrganizations", "listSourceReceipts", "listClaims",
  "createSourceReceipt", "createClaim", "correctClaim",
  "listUploads", "createUpload", "createUploadStream",
  "promoteUpload", "createUploadDownloadLink", "listVerificationCases",
  "getReviewAssignmentOptions", "transitionVerificationCase", "createAttestation",
  "createSignatureRequest", "submitAttestationSignature", "createVerificationCase",
  "getReadinessPolicyOptions", "createReadinessAssessment", "getReadinessAssessment",
  "createGateDecisionSignatureRequest", "createGateDecision", "exportSignedReviewBundle",
  "draftRegistryVersion", "listRegistryDrafts", "publishRegistryVersion",
  "rejectRegistryDraft", "listAnchorBatches", "createAnchorBatch",
  "resubmitAnchorBatch", "recordSecondReview", "getDocumentGraph",
  "updateDocumentProfile", "getDocumentImpactPreview", "listDocumentImpacts",
  "createDocumentLink", "removeDocumentLink", "revokeDocument", "resolveDocumentImpacts",
  "createDocumentRequirement", "retireDocumentRequirement", "listDocumentLinkRules",
  "createClaimConflict", "createClaimDerivation", "getClaimTypeVersion",
  "listStaleSignals", "listDisputes", "listActiveDisclosureRestrictions",
  "listDocumentRequirements", "getDocumentStatusSummary", "listProjectDocuments",
  "getProjectLifecycle", "transitionProjectLifecycle", "getOfferingGate",
  "getMyWork", "getMyActivity", "listRegistryEntries",
  "listAccountWallets", "createWalletBindingChallenge", "bindAccountWallet",
  "getProjectOverview", "getEvidenceLedger", "listNotifications", "markNotificationRead",
]);
const operations = ROUTES.filter(route => developmentOperations.has(route.operationId));
export const developmentRoutes = new Set(operations.map(route => `${route.method.toUpperCase()} ${toFastifyPath(route.path)}`));
export const developmentActions = new Set(operations.map(route => route.action));
