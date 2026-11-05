import { creReport, creWorkspace, creDelivery, type createCreReportRequest } from "@mpc/api-contract";
import { apiFetch, ApiError, type ApiErrorEnvelope } from "./api";

export type CreWorkspace = ReturnType<typeof creWorkspace.parse>;
export type CreReport = ReturnType<typeof creReport.parse>;
export type CreDelivery = ReturnType<typeof creDelivery.parse>;
async function read<T>(response: Response, schema: { parse(value: unknown): T }): Promise<T> {
  const body: unknown = await response.json();
  if (!response.ok) throw new ApiError(response.status, body as ApiErrorEnvelope);
  return schema.parse(body);
}
const path = (projectId: string) => `/api/v1/projects/${encodeURIComponent(projectId)}/cre-reports`;
export const getCreWorkspace = async (projectId: string) => read(await apiFetch(path(projectId), { cache: "no-store" }), creWorkspace);
export const generateCreReport = async (projectId: string, input: ReturnType<typeof createCreReportRequest.parse>, key: string) =>
  read(await apiFetch(path(projectId), { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(input) }), creReport);
export const getCreDelivery = async (projectId: string, reportId: string) =>
  read(await apiFetch(`${path(projectId)}/${encodeURIComponent(reportId)}/delivery`, { cache: "no-store" }), creDelivery);

export const CRE_STATUS: Record<number, string> = {
  1: "No reported health warning", 2: "Re-review required", 3: "Public version revoked",
  4: "Expired (reserved)", 5: "Health unavailable",
};
