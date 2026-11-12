"use client";

import Link from "next/link";
import { use, useEffect, useRef, useState } from "react";
import { createCreReportRequest } from "@mpc/api-contract";
import { ErrorNotice } from "@/components/ErrorNotice";
import { newIdempotencyKey } from "@/lib/api";
import { useSession } from "@/lib/session";
import { CRE_STATUS, generateCreReport, getCreDelivery, getCreWorkspace, type CreDelivery, type CreWorkspace } from "@/lib/cre-api";

const deliveryLabels: Record<CreDelivery["state"], string> = {
  matched: "Receiver matches this report", different: "Receiver contains a different observation",
  empty: "Receiver has no observation for this record", unavailable: "Receiver state could not be verified",
  not_configured: "Chain RPC is not configured",
};

export default function CrePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { token, loading } = useSession();
  const [data, setData] = useState<CreWorkspace | null>(null);
  const [receiver, setReceiver] = useState("");
  const [ttl, setTtl] = useState("300");
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [delivery, setDelivery] = useState<Record<string, CreDelivery>>({});
  // A retry after a network failure must reuse the key for the same request.
  const pending = useRef<{ body: string; key: string } | null>(null);

  useEffect(() => {
    if (!token) return;
    let live = true;
    setData(null); setDelivery({}); setError(null); setMessage(""); pending.current = null;
    getCreWorkspace(id).then(value => { if (live) setData(value); }).catch(e => { if (live) setError(e); });
    return () => { live = false; };
  }, [id, token]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(null); setMessage("");
    try { await action(); } catch (e) { setError(e); } finally { setBusy(false); }
  }

  const supported = data?.chainId === "97" || data?.chainId === "5611" || data?.chainId === "31337";
  const input = data?.publication ? createCreReportRequest.safeParse({
    publicKey: data.publication.publicKey, chainId: data.chainId, receiver: receiver.toLowerCase(), ttlSeconds: ttl,
  }) : null;
  const valid = input?.success === true;
  const downloadConfig = () => {
    if (!input?.success || !supported) return;
    const config = { schedule: "0 */5 * * * *", reportUrl: `${window.location.origin}/api/v1/projects/${id}/cre-reports`,
      ...input.data, chainName: data?.chainId === "97" ? "binance_smart_chain-testnet" : data?.chainId === "5611" ? "binance_smart_chain-testnet-opbnb-1" : "anvil-devnet",
      gasLimit: "500000", allowLocalHttp: data?.chainId === "31337" && ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(config, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = (data?.chainId === "97" || data?.chainId === "5611") ? "config.dev.json" : "config.local.json";
    link.click(); URL.revokeObjectURL(url);
  };

  function renderDelivery() {
    if (!data) return null;
    return (
      <section className="panel"><h2>3. Run CRE and check delivery</h2>
        <p>Run the deployed CRE workflow using this configuration and its Registry service credential. The browser does not hold the credential or trigger a DON execution.</p>
        <p className="sub">The CRE executor must be able to reach this site's API. An internal-only dev address requires a reachable integration endpoint. Chainlink capability and forwarder support must be confirmed for the selected network.</p>
        <p>After a CRE execution, refresh reports and check the receiver below. Generating a report alone is not evidence of delivery.</p>
        <button disabled={busy} onClick={() => run(async () => { setData(await getCreWorkspace(id)); setDelivery({}); })}>Refresh reports</button>
        {!data.rpcConfigured ? <p>Receiver checks are unavailable until the API's chain RPC is configured.</p> : null}
        <h3>Latest 20 reports</h3>
        {data.reports.length === 0 ? <p>No reports have been generated yet.</p> : data.reports.map(({ id: reportId, report }) => <article className="panel" key={reportId}>
          <p><strong>Observation {report.sequence}: {CRE_STATUS[report.status]}</strong></p>
          <p className="meta">Version {report.registryVersion} · chain {report.chainId} · receiver <span className="mono">{report.receiver}</span></p>
          <p>Observed: {new Date(Number(report.observedAt) * 1000).toISOString()}<br />Valid until: {new Date(Number(report.validUntil) * 1000).toISOString()}</p>
          <button disabled={busy || !data.rpcConfigured || report.chainId !== data.chainId} onClick={() => run(async () => {
            const result = await getCreDelivery(id, reportId); setDelivery(previous => ({ ...previous, [reportId]: result }));
          })}>Check receiver</button>
          {delivery[reportId] ? <div role="status"><p>{deliveryLabels[delivery[reportId].state]}</p>
            {delivery[reportId].checkedAt ? <p>At chain time {new Date(Number(delivery[reportId].checkedAt) * 1000).toISOString()}:
              {delivery[reportId].fresh ? " within transport validity" : " no fresh observation"}.</p> : null}
            {delivery[reportId].report ? <p>Receiver sequence: {delivery[reportId].report.sequence} · {CRE_STATUS[delivery[reportId].report.status]}</p> : null}
          </div> : <p className="meta">Receiver state not checked.</p>}
        </article>)}
      </section>
    );
  }

  function renderReportForm() {
    if (!data) return null;
    return <>
      <section className="panel"><h2>2. Prepare a report</h2>
        <p>Destination chain: <strong>{data.chainId === "97" ? "BSC Testnet (97)" : data.chainId === "5611" ? "opBNB testnet (5611)" : data.chainId}</strong></p>
        {!supported ? <p role="alert">This chain is not supported by the Registry CRE workflow.</p> : null}
        <label>Receiver contract address<input value={receiver} onChange={e => setReceiver(e.target.value.trim())} placeholder="0x…" autoComplete="off" disabled={busy} /></label>
        <p className="sub">Use the deployed RegistryStatusReceiver address on this chain, with the intended forwarder and workflow identity configured.</p>
        <label>Report validity (seconds)<input type="number" min="1" max="3600" value={ttl} onChange={e => setTtl(e.target.value)} disabled={busy} /></label>
        {receiver && !valid && data.publication ? <p role="alert">Enter a nonzero contract address and a whole-number validity from 1 to 3600 seconds.</p> : null}
        <div className="row">
          <button disabled={busy || !valid || !supported} onClick={() => run(async () => {
            if (!input?.success) return;
            const body = JSON.stringify(input.data);
            if (pending.current?.body !== body) pending.current = { body, key: newIdempotencyKey() };
            await generateCreReport(id, input.data, pending.current.key);
            pending.current = null;
            setMessage("Report generated. It has not been submitted to CRE or the chain by this action.");
            setData(await getCreWorkspace(id));
          })}>Generate report</button>
          <button disabled={busy || !valid || !supported} onClick={downloadConfig}>Download workflow configuration</button>
        </div>
      </section>

    </>;
  }

  return <>
    <div className="page-head"><div><h1>CRE</h1><p className="sub">Send an approved project's current status to a chain receiver.</p></div>
      <Link href={`/w/projects/${id}`}>Back to project</Link></div>
    {error ? <ErrorNotice error={error} /> : null}
    {loading || (token && !data && !error) ? <p role="status">Loading CRE prerequisites…</p> : null}
    {!loading && !token ? <p>Sign in to view this project's CRE status.</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {token && error && !data ? <button disabled={busy} onClick={() => run(async () => setData(await getCreWorkspace(id)))}>Retry</button> : null}
    {data ? <>
      <section className="panel"><h2>1. Publish the project</h2>
        {data.publication ? <p>Public key: <span className="mono">{data.publication.publicKey}</span> · version {data.publication.version} · {data.publication.status}</p>
          : <p>No approved public version exists. Create a publication draft, then have a different Disclosure Approver publish it.</p>}
        <Link href={`/w/projects/${id}/publication`}>Open publication →</Link>
        <p className="sub">A report describes the published record and its current warnings. It does not approve evidence or change publication.</p>
      </section>
      {renderReportForm()}
      {renderDelivery()}
    </> : null}
  </>;
}
