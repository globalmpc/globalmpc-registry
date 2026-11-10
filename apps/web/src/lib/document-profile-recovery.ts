import { updateDocumentProfileRequest } from "@mpc/api-contract";
import {
  ApiError,
  getDocumentGraph,
  newIdempotencyKey,
  updateDocumentProfile,
  type ObjectUpload,
} from "./api";

export type ProfileChanges = Parameters<typeof updateDocumentProfile>[3];
export type ProfileAttempt = {
  current: { fingerprint: string; key: string } | null;
};

/** Retries bind the exact resource version and normalized payload, not just a file ID. */
export async function saveDocumentProfileWithRecovery(
  token: string,
  projectId: string,
  upload: ObjectUpload,
  changes: ProfileChanges,
  attempt: ProfileAttempt,
  onReload: (upload: ObjectUpload) => void,
): Promise<ObjectUpload> {
  const same = (value: ObjectUpload, target: ProfileChanges) =>
    (Object.keys(target) as (keyof ProfileChanges)[]).every(
      (key) => (value[key] ?? null) === target[key],
    );
  const patch = (value: ObjectUpload) => {
    const fingerprint = JSON.stringify([value.id, value.version, changes]);
    if (attempt.current?.fingerprint !== fingerprint)
      attempt.current = { fingerprint, key: newIdempotencyKey() };
    return updateDocumentProfile(
      token,
      value.id,
      value.version,
      changes,
      attempt.current.key,
    );
  };
  if (same(upload, changes) && !attempt.current) return upload;
  try {
    return await patch(upload);
  } catch (conflict) {
    if (
      !(conflict instanceof ApiError) ||
      conflict.status !== 412 ||
      conflict.envelope.code !== "RESOURCE_VERSION_MISMATCH"
    )
      throw conflict;
    const graph = await getDocumentGraph(token, projectId, upload.id);
    const node = graph.nodes.find((value) => value.uploadId === upload.id);
    if (!node)
      throw new Error(
        "The uploaded document is no longer available in this project.",
      );
    const latest = {
      ...upload,
      version: node.version,
      documentType: node.documentType,
      validUntil: node.validUntil,
      supersedesUploadId: node.supersedesUploadId,
      state: node.state,
      revokedAt: node.revokedAt,
    };
    if (
      node.revokedAt ||
      node.supersededByUploadId ||
      ["scanned_infected", "rejected"].includes(node.state)
    )
      throw new Error(
        "This document is no longer usable. Open its stored record before continuing.",
      );
    onReload(latest);
    if (same(latest, changes)) return latest;
    const oldFields = Object.fromEntries(
      Object.keys(changes).map((key) => [
        key,
        upload[key as keyof ProfileChanges] ?? null,
      ]),
    ) as ProfileChanges;
    if (!same(latest, oldFields))
      throw new Error(
        `Classification changed on the server (type: ${latest.documentType ?? "not set"}; valid until: ${latest.validUntil ?? "not set"}). Review your values and retry to apply them.`,
      );
    // Only scanner/state changes are automatically rebased, once per explicit submission.
    return patch(latest);
  }
}

/** Use the server's field constraints before the irreversible first upload. */
export function validateDocumentClassification(
  input: Pick<ProfileChanges, "documentType" | "validUntil">,
) {
  const parsed = updateDocumentProfileRequest
    .pick({ documentType: true, validUntil: true })
    .safeParse(input);
  if (!parsed.success)
    throw new Error(
      parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
    );
  const day = parsed.data.validUntil;
  if (
    day &&
    (!Number.isFinite(Date.parse(`${day}T00:00:00Z`)) ||
      new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day)
  )
    throw new Error("Valid until must be a real calendar date.");
  return parsed.data;
}
