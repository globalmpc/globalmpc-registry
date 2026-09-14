"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createProject, newIdempotencyKey } from "@/lib/api";
import { useSession } from "@/lib/session";
import { ErrorNotice } from "@/components/ErrorNotice";

/**
 * 조직 ID는 seed 데이터의 값이다. 실제 제품에서는 세션의 organization 목록에서
 * 고르지만, R0에는 organization 조회 API가 아직 없다.
 */
/**
 * tenant별 조직. 실제 제품에서는 세션의 organization 목록에서 고르지만
 * R1에는 organization 조회 API가 아직 없다.
 */
const DEMO_ORGS_BY_TENANT: Record<string, { label: string; id: string }> = {
  "e0000000-0000-4000-8000-00000000000a": {
    label: "MPC Operations A (tenant A)",
    id: "aaaaaaaa-0000-0000-0000-000000000001",
  },
  "e0000000-0000-4000-8000-00000000000b": {
    label: "MPC Operations B (tenant B)",
    id: "bbbbbbbb-0000-0000-0000-000000000001",
  },
};

export default function NewProjectPage() {
  const { token, session } = useSession();
  const router = useRouter();

  const [projectKey, setProjectKey] = useState("");
  const [name, setName] = useState("");
  const [hostCountry, setHostCountry] = useState("MNG");
  const [minerals, setMinerals] = useState("copper");
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);
  // 폼 인스턴스마다 하나의 key를 유지한다. 사용자가 제출 버튼을 두 번 눌러도
  // 같은 key가 가므로 서버가 중복 실행을 막는다(07 §7.1).
  const [idempotencyKey] = useState(() => newIdempotencyKey());

  if (!token) {
    return <p className="sub">No account is connected.</p>;
  }

  const org = session?.tenantId ? DEMO_ORGS_BY_TENANT[session.tenantId] : undefined;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!token || !org) return;

    setSubmitting(true);
    setError(null);
    try {
      const created = await createProject(
        token,
        {
          projectKey: projectKey.trim(),
          name: name.trim(),
          hostCountryIso3: hostCountry.trim().toUpperCase(),
          minerals: minerals
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
          ownerOrganizationId: org.id,
        },
        idempotencyKey,
      );
      router.push(`/w/projects/${created.id}`);
    } catch (caught) {
      setError(caught);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>New project</h1>
          <p className="sub">
            Registration starts in <span className="mono">draft</span>. Items such as rights,
            issuer, and SPV stay <span className="mono">pending</span> until their evidence is
            confirmed.
          </p>
        </div>
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      <form className="panel" onSubmit={submit} style={{ maxWidth: 560 }}>
        <div className="field">
          <label htmlFor="projectKey">Project key</label>
          <input
            id="projectKey"
            className="mono"
            value={projectKey}
            onChange={(event) => setProjectKey(event.target.value)}
            placeholder="SYNTH-PROJECT-003"
            required
            maxLength={64}
          />
        </div>

        <div className="field">
          <label htmlFor="name">Name</label>
          <input
            id="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Project name"
            required
          />
        </div>

        <div className="field">
          <label htmlFor="hostCountry">Host country (ISO3)</label>
          <input
            id="hostCountry"
            className="mono"
            value={hostCountry}
            onChange={(event) => setHostCountry(event.target.value)}
            maxLength={3}
            minLength={3}
            required
          />
        </div>

        <div className="field">
          <label htmlFor="minerals">Minerals (comma separated)</label>
          <input
            id="minerals"
            value={minerals}
            onChange={(event) => setMinerals(event.target.value)}
            placeholder="copper, gold"
          />
        </div>

        <div className="field">
          <label>Owning organization</label>
          <div className="meta mono">{org ? `${org.label} · ${org.id}` : "No organization"}</div>
        </div>

        <div className="row">
          <button type="submit" className="primary" disabled={submitting || !org}>
            {submitting ? "Registering…" : "Register"}
          </button>
          <span className="meta">
            Idempotency-Key <span className="mono">{idempotencyKey.slice(0, 12)}…</span>
          </span>
        </div>
      </form>

      <p className="meta">
        On success the audit event and the outbox event are written in the same transaction. On
        failure neither remains.
      </p>
    </>
  );
}
