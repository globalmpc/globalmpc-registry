"use client";

import Link from "next/link";
import { COPY } from "@/lib/copy";
import { useSession } from "@/lib/session";
import { Address } from "@/components/Address";

/**
 * 권한이 막혔을 때 도착하는 화면.
 *
 * `authorize()`가 거절하면서 `accessRequestPath`를 돌려주고, `ErrorNotice`가 그것을
 * 링크로 건다(11 §11.7 "Permission: 필요한 role과 access request 경로"). 그 경로에
 * 화면이 없으면 사용자는 "권한을 요청하라"는 안내를 따라가 404를 만난다.
 *
 * **이 화면은 요청을 접수하지 않는다.** 접수 API가 없기 때문이다. 없는 것을 있는
 * 것처럼 보이는 버튼을 두면, 누른 사람은 요청이 접수됐다고 믿고 기다린다. 그래서
 * 지금 무엇이 부족하고 누가 그것을 줄 수 있는지만 적는다.
 */

export type AccessRequestKind = "assurance" | "role" | "project";

const HEADINGS: Readonly<Record<AccessRequestKind, string>> = {
  assurance: "Identity assurance is not high enough",
  role: "No role allows this action",
  project: "Not assigned to this project",
};

const EXPLANATIONS: Readonly<Record<AccessRequestKind, string>> = {
  assurance:
    "You are signed in. A wallet signature establishes who controls this session — " +
    "the assurance level a role requires is a separate fact (02 §2.9).",
  role:
    "A role is a function held in an organization; it is a different record from " +
    "sign-in and from holding a credential (02 §2.9). Without one, reads work and " +
    "change requests are refused.",
  project:
    "Having the role is not enough if the role is not bound to this project. Tenant " +
    "and project scope are decided by the server, not by the screen.",
};

export function AccessRequestPanel({
  kind,
  projectId,
}: {
  kind: AccessRequestKind;
  projectId?: string;
}) {
  const { session, loading } = useSession();

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{HEADINGS[kind]}</h1>
          <p className="sub">{EXPLANATIONS[kind]}</p>
        </div>
      </div>

      <div className="notice" style={{ color: "var(--alert)" }}>
        <div className="title">This screen does not file a request</div>
        There is no intake API yet. A tenant operator grants access directly on the
        deployment (<span className="mono">docker compose … --profile bootstrap</span>).
        What this screen is for: <strong>what is missing</strong> and{" "}
        <strong>what to hand the operator</strong>.
      </div>

      <div className="panel">
        <h2>Where you stand</h2>
        {loading ? (
          <p className="sub">Loading…</p>
        ) : session?.authenticated ? (
          <div className="meta">
            <div>
              Tenant <span className="mono">{session.tenantId?.slice(0, 8) ?? "—"}</span>
            </div>
            <div>
              Wallet {session.walletAddress ? <Address value={session.walletAddress} /> : "—"}
            </div>
            <div>
              Assurance level <span className="mono">{session.assuranceLevel ?? "—"}</span>
            </div>
            <div>
              Roles{" "}
              <span className="mono">
                {session.roleBindings?.map((binding) => binding.role).join(", ") ||
                  COPY.session.noRoles}
              </span>
            </div>
            {projectId ? (
              <div>
                Project <span className="mono">{projectId}</span>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="sub">
            {COPY.session.required} <Link href="/connect">{COPY.session.connect}</Link>
          </p>
        )}
      </div>

      <div className="panel">
        <h2>What to hand the operator</h2>
        <p className="sub">
          Pass these values as they are. A different wallet address binds the role to a
          different person.
        </p>
        <ul>
          <li>
            Wallet address —{" "}
            {session?.walletAddress ? (
              <Address value={session.walletAddress} />
            ) : (
              <span className="mono">shown once signed in</span>
            )}
          </li>
          <li>
            Required role — the value listed under{" "}
            <span className="mono">One of these roles is required</span> on the refusal
          </li>
          <li>
            {kind === "assurance"
              ? "Required assurance level — the value on the refusal. Granting less than the role requires still writes the row, and every request is then refused"
              : "Scope — the tenant and the project"}
          </li>
        </ul>
        <p className="meta">
          A role is not a credential and not an assignment. Signing an attestation needs
          all three (02 §2.8).
        </p>
      </div>

      <p className="meta">
        <Link href="/w/projects">Back to projects →</Link>
      </p>
    </>
  );
}
