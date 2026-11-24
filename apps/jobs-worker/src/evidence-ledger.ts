import {canonicalBytes} from "@mpc/canonical";
import type postgres from "postgres";
import { computeEvidenceLedger, persistEvidenceLedger, evidenceLedgerSemantic } from "@mpc/db";
import type { LedgerSnapshot } from "@mpc/db";

export const DEFAULT_LEDGER_SWEEP_MS = 60_000;
export const DEFAULT_LEDGER_BATCH_SIZE = 25;
/** Worker records changed outcomes, while request-time evaluation prevents stale success windows. */
export function createLedgerSweep(sql:postgres.Sql,intervalMs=DEFAULT_LEDGER_SWEEP_MS,now:()=>number=Date.now,batchSize=DEFAULT_LEDGER_BATCH_SIZE) {
  if(!Number.isInteger(batchSize)||batchSize<1||batchSize>100)throw new RangeError("Ledger batch size must be between 1 and 100");
  let lastAttempt:number|null=null;
  let cursor:string|null=null;
  return async()=>{
    const timestamp=now();
    if(lastAttempt!==null && timestamp-lastAttempt<intervalMs)return{ran:false,recorded:0};
    lastAttempt=timestamp;
    // The worker role owns the every-project sweep (it bypasses RLS); the application role does not.
    const page=async(after:string|null)=>sql<{id:string}[]>`
      SELECT p.id FROM core.projects p WHERE (${after}::uuid IS NULL OR p.id>${after}::uuid) AND (
        EXISTS (
        SELECT 1 FROM core.claims c WHERE c.project_id=p.id AND c.catalog_entry_id IS NOT NULL
      ) OR EXISTS (
        SELECT 1 FROM core.evidence_ledger_snapshots s WHERE s.project_id=p.id
      )) ORDER BY p.id LIMIT ${batchSize}
    `;
    let projects=await page(cursor);
    if(projects.length===0 && cursor!==null){
      cursor=null;
      projects=await page(null);
    }
    const failures:unknown[]=[];
    let recorded=0;
    for(const project of projects){
      try {
        await sql.begin(async tx=>{
          const fresh=await computeEvidenceLedger(tx, project.id,new Date(timestamp));
          if(!fresh)return;
          const [previous]=await tx<{snapshot:LedgerSnapshot}[]>`SELECT snapshot FROM core.evidence_ledger_snapshots
            WHERE project_id=${project.id} ORDER BY created_at DESC,id DESC LIMIT 1`;
          if(previous && Buffer.from(canonicalBytes(evidenceLedgerSemantic(previous.snapshot))).equals(Buffer.from(canonicalBytes(evidenceLedgerSemantic(fresh)))))return;
          const snapshot=await persistEvidenceLedger(tx, fresh);
          await tx`INSERT INTO audit.events(project_id,command,resource_type,resource_id,correlation_id,detail)
            VALUES (${project.id},'evidence_ledger.assessed','evidence_ledger_snapshot',${snapshot.id},${snapshot.id},
            ${tx.json({actor:'jobs_worker',inputSnapshotHash:snapshot.inputSnapshotHash})})`;
          recorded++;
        });
      } catch(error){
        failures.push(error);
      } finally {
        // Failed projects get another attempt after wrap; one failure cannot starve later IDs.
        cursor=project.id;
      }
    }
    if(failures.length)throw new AggregateError(failures,"Evidence ledger batch contained failed assessments");
    return{ran:true,recorded};
  };
}

/** Keep slow assessments off the delivery loop; shutdown drains the one in-flight sweep. */
export function createLedgerSweepRunner(
  sweep: () => Promise<{ran: boolean; recorded: number}>,
  onResult: (result: {ran: boolean; recorded: number}) => void,
  onError: (error: unknown) => void,
) {
  let pending: Promise<void> | null = null;
  let stopped = false;
  return {
    kick(): void {
      if (stopped || pending) return;
      pending = Promise.resolve().then(sweep).then(onResult).catch(onError).finally(() => {
        pending = null;
      });
    },
    async stop(): Promise<void> {
      stopped = true;
      await pending;
    },
  };
}
