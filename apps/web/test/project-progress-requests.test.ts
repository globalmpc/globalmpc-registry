import { afterEach, expect, it, vi } from "vitest";
import { ApiError } from "../src/lib/api";
import { getEvidenceLedger } from "../src/lib/evidence-ledger-api";
import { createProgressRequests, ProgressRateLimited } from "../src/lib/project-progress-requests";
vi.mock("../src/lib/evidence-ledger-api", () => ({getEvidenceLedger: vi.fn()}));
const result = {snapshot:{evaluatedAt:"now",inputSnapshotHash:"hash",items:[],stages:[],currentStage:null,limitations:[]}};
const flush = async () => {for(let i=0;i<8;i++) await Promise.resolve();};
afterEach(() => {vi.resetAllMocks();vi.useRealTimers();});
it("bounds 100 visible rows to two concurrent reads", async () => {
  const queue=createProgressRequests();
  const releases:(()=>void)[]=[];let active=0;let peak=0;
  vi.mocked(getEvidenceLedger).mockImplementation(() => new Promise(resolve => {
    active++;peak=Math.max(peak,active);
    releases.push(()=>{active--;resolve(result);});
  }));
  const jobs=Array.from({length:100},(_,i)=>queue.load("session",`p${i}`,new AbortController().signal));
  expect(getEvidenceLedger).toHaveBeenCalledTimes(2);
  for(let i=0;i<100;i++) {releases[i]();await flush();}
  await Promise.all(jobs);expect(peak).toBe(2);expect(active).toBe(0);
});
it("drops obsolete queued rows while keeping running slots occupied until settlement", async () => {
  const queue=createProgressRequests();const releases:(()=>void)[]=[];
  vi.mocked(getEvidenceLedger).mockImplementation(()=>new Promise(resolve=>releases.push(()=>resolve(result))));
  const active=new AbortController();const queued=new AbortController();
  const first=queue.load("old-session","running",active.signal).catch(error=>error);
  const second=queue.load("old-session","other-running",new AbortController().signal);
  const cancelled=queue.load("old-session","obsolete",queued.signal).catch(error=>error);
  const replacement=queue.load("new-session","replacement",new AbortController().signal);
  active.abort();queued.abort();await flush();
  expect(getEvidenceLedger).toHaveBeenCalledTimes(2);
  expect((await first).name).toBe("AbortError");expect((await cancelled).name).toBe("AbortError");
  releases[0]();await flush();
  expect(getEvidenceLedger).toHaveBeenLastCalledWith("new-session","replacement");
  expect(getEvidenceLedger).not.toHaveBeenCalledWith("old-session","obsolete");
  releases[1]();releases[2]();await Promise.all([second,replacement]);
});
it("429 drops the pending wave and suppresses new demand without automatic retries", async () => {
  vi.useFakeTimers();const queue=createProgressRequests();
  let rejectFirst!:(error:unknown)=>void;let resolveSecond!:(value:typeof result)=>void;
  vi.mocked(getEvidenceLedger).mockImplementationOnce(()=>new Promise((_,reject)=>{rejectFirst=reject;}))
    .mockImplementationOnce(()=>new Promise(resolve=>{resolveSecond=resolve;})).mockResolvedValue(result);
  const jobs=Array.from({length:20},(_,i)=>queue.load("session",`p${i}`,new AbortController().signal).catch(error=>error));
  rejectFirst(new ApiError(429,{code:"RATE_LIMITED",message:"Wait",retryable:true,correlationId:"test"}));
  await flush();resolveSecond(result);await flush();
  const results=await Promise.all(jobs);
  expect(results.filter(value=>value instanceof ProgressRateLimited)).toHaveLength(19);
  await expect(queue.load("session","later",new AbortController().signal)).rejects.toBeInstanceOf(ProgressRateLimited);
  expect(getEvidenceLedger).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(60_001);await flush();expect(getEvidenceLedger).toHaveBeenCalledTimes(2);
  await expect(queue.load("session","explicit-new-demand",new AbortController().signal)).resolves.toEqual(result);
});
it("keeps a failed read from stopping unrelated rows and ignores already-cancelled demand", async () => {
  const queue=createProgressRequests();const controller=new AbortController();controller.abort();
  await expect(queue.load("session","obsolete",controller.signal)).rejects.toMatchObject({name:"AbortError"});
  expect(getEvidenceLedger).not.toHaveBeenCalled();
  vi.mocked(getEvidenceLedger).mockRejectedValueOnce(new Error("Offline")).mockResolvedValue(result);
  const jobs=[queue.load("session","failed",new AbortController().signal).catch(error=>error),queue.load("session","ok",new AbortController().signal),queue.load("session","queued",new AbortController().signal)];
  expect(await Promise.all(jobs)).toEqual([expect.any(Error),result,result]);
});
