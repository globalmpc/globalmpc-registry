"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { getProject, listAdminSubjects, type AdminSubject } from "@/lib/api";
import { useSession } from "@/lib/session";
import { ErrorNotice } from "@/components/ErrorNotice";

export default function ProjectTeamPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { token, session } = useSession();
  const [people, setPeople] = useState<AdminSubject[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const allowed = session?.actions?.includes("admin.read") === true;
  useEffect(() => {
    if (!token || !allowed) return;
    let live = true;
    setPeople(null);
    setError(null);
    getProject(token, id)
      .then(() => listAdminSubjects(token))
      .then((result) => {
        if (live) setPeople(result.items);
      })
      .catch((caught: unknown) => {
        if (live) setError(caught);
      });
    return () => {
      live = false;
    };
  }, [id, token, allowed]);
  const members = (people ?? []).filter(
    (person) =>
      person.kind === "person" &&
      person.roles.some((role) => role.projectId === id && !role.revokedAt),
  );
  const organizationWide = (people ?? []).filter(
    (person) =>
      person.kind === "person" &&
      person.roles.some((role) => role.projectId === null && !role.revokedAt),
  );
  function table(rows: AdminSubject[], projectOnly: boolean) {
    return rows.length === 0 ? (
      <p className="sub">No active assignments recorded in this scope.</p>
    ) : (
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Member</th>
              <th>Assigned roles</th>
              <th>Account status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((person) => (
              <tr key={person.id}>
                <td>{person.displayName}</td>
                <td>
                  {person.roles
                    .filter(
                      (role) =>
                        !role.revokedAt &&
                        (projectOnly
                          ? role.projectId === id
                          : role.projectId === null),
                    )
                    .map((role) => role.role.replaceAll("_", " "))
                    .join(", ")}
                </td>
                <td>
                  {person.suspendedAt
                    ? "Suspended"
                    : person.locked
                      ? "Sign-in unavailable"
                      : "Account available"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Team</h1>
          <p className="sub">
            Project assignments and organization-wide roles are shown
            separately. Assigned roles still require the session’s identity and
            authentication level.
          </p>
        </div>
        {allowed ? (
          <Link href="/w/admin">Invitations and role approvals →</Link>
        ) : null}
      </div>
      {!allowed ? (
        <p className="notice">
          Your session cannot read the team directory.{" "}
          <Link href={`/w/projects/${id}/access-requests`}>
            Request access →
          </Link>
        </p>
      ) : error ? (
        <ErrorNotice error={error} />
      ) : !people ? (
        <p role="status">Loading team…</p>
      ) : (
        <>
          <section className="panel">
            <h2>Project assignments</h2>
            {table(members, true)}
          </section>
          <section className="panel">
            <h2>Organization-wide roles</h2>
            <p className="sub">
              These are broader role grants, not an assertion of membership or
              access to every project. Server authorization applies to each
              action.
            </p>
            {table(organizationWide, false)}
          </section>
        </>
      )}
    </>
  );
}
