import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { withTenant, computeEvidenceLedger, persistEvidenceLedger, publicLedgerProjection } from "@mpc/db";
import { assertAuthorized, projectResource, sessionFacts } from "../plugins/authorize.js";
import { requireReadContext, requireMutationContext } from "./shared.js";
import { notFound, badRequest } from "../errors.js";
import { hashRequest, withIdempotency } from "../plugins/idempotency.js";
import { recordAudit } from "../audit.js";

/** Separate computed ledger: recomputation does not mutate manual facts, readiness or approvals. */
export async function registerEvidenceLedgerRoutes(app: FastifyInstance, sql: postgres.Sql): Promise<void> {
  app.get<{Params:{projectId:string}}>("/api/v1/projects/:projectId/evidence-ledger", async (request) => {
    const {session,tenantId} = requireReadContext(request);
    assertAuthorized(session,"readiness.read",projectResource(tenantId,request.params.projectId),sessionFacts(session));
    const snapshot = await withTenant(sql,{tenantId},(tx)=>computeEvidenceLedger(tx,tenantId,request.params.projectId,new Date(request.context.asOf)));
    if (!snapshot) throw notFound("Project not found");
    return {snapshot,requestId:request.context.requestId,asOf:request.context.asOf};
  });
  app.post<{Params:{projectId:string}}>("/api/v1/projects/:projectId/evidence-ledger",async(request)=>{
    const {session,tenantId,idempotencyKey}=requireMutationContext(request);
    if (request.body !== undefined && (request.body === null || typeof request.body !== 'object' || Object.keys(request.body).length > 0)) {
      throw badRequest("REQUEST_INVALID","Ledger recomputation accepts no client-supplied results or evaluation time");
    }
    const effectiveRole=assertAuthorized(session,"readiness.recompute",projectResource(tenantId,request.params.projectId),sessionFacts(session));
    return withTenant(sql,{tenantId},tx=>withIdempotency(tx,tenantId,idempotencyKey,hashRequest(request),async()=>{
      const fresh=await computeEvidenceLedger(tx,tenantId,request.params.projectId,new Date(request.context.asOf));
      if (!fresh) throw notFound("Project not found");
      const snapshot=await persistEvidenceLedger(tx,tenantId,fresh);
      await recordAudit(tx,{effectiveRole,tenantId,projectId:request.params.projectId,session,
        command:"evidence_ledger.assessed",resourceType:"evidence_ledger_snapshot",resourceId:snapshot.id,
        correlationId:request.context.correlationId,requestIp:request.clientIp,
        detail:{inputSnapshotHash:snapshot.inputSnapshotHash,evaluatorVersion:snapshot.evaluatorVersion}});
      return {snapshot,publicProjection:publicLedgerProjection(snapshot),requestId:request.context.requestId,asOf:request.context.asOf};
    }));
  });
}
