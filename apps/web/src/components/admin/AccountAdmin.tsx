"use client";

import { useCallback, useEffect, useState } from "react";
import {
  createEmailChange,
  createInvitation,
  createSubjectSuspension,
  decideEmailChange,
  decideSubjectSuspension,
  listEmailChanges,
  listInvitations,
  listSubjectSuspensions,
  revokeInvitation,
  type Decision,
  type EmailChange,
  type Invitation,
  type InvitationRole,
  type SubjectSuspension,
} from "@/lib/account-api";
import { HUMAN_ROLE_LABELS, HUMAN_ROLES } from "@mpc/api-contract";
import { listProjectItems, type ProjectListItem } from "@/lib/projects-api";
import { listOrganizations, newIdempotencyKey, type AdminSubject, type OrganizationOption } from "@/lib/api";
import { authErrorMessage } from "@/lib/auth-errors";
import { AUTH_COPY } from "@/lib/copy";
import { useSession } from "@/lib/session";
import { WalletRecoveryPanel } from "../settings/WalletRecoveryPanel";
import { can } from "@/lib/access";

const C = AUTH_COPY.admin;
/** A suspension's closure in words; an unknown reason still reads as closed, never as open. */
const closed = (reason: string) => C.closedReason[reason] ?? `Closed — ${reason.replace(/_/g, " ")}`;

/**
 * Account administration — invitations (WP2), email changes (WP2), second-factor resets (WP3) and
 * suspension (AUTH-06).
 *
 * The two-person rules are the server's: whoever proposes a change or a reset cannot decide it,
 * nobody decides their own, and someone who took part in one recovery flow for a person cannot take
 * part in the other for 30 days (`ACCOUNT_RECOVERY_SEPARATION_REQUIRED`). The screen hides the
 * decision buttons from the proposer only to save a click; the refusal codes still reach the screen
 * as one sentence each.
 */
export function AccountAdmin({
  subjects,
  onChanged,
}: {
  readonly subjects: readonly AdminSubject[];
  readonly onChanged: () => Promise<void> | void;
}) {
  const { token, session } = useSession();
  // Reading these lists (`admin.read`) does not authorize a change: each control needs its own
  // action. Guidance only; the server decides.
  const mayInvite = can(session, "admin.invitation.manage");
  const mayProposeEmail = can(session, "admin.email_change.propose");
  const mayProposeSuspension = can(session, "admin.subject_suspension.propose");
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [changes, setChanges] = useState<EmailChange[]>([]);
  const [suspensions, setSuspensions] = useState<SubjectSuspension[]>([]);
  const [organizations, setOrganizations] = useState<OrganizationOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteOrg, setInviteOrg] = useState("");
  const [inviteRole, setInviteRole] = useState<InvitationRole | "">("project_member");
  const [inviteProject, setInviteProject] = useState("");
  const [identityBasis, setIdentityBasis] = useState("");
  const [projectListIncomplete, setProjectListIncomplete] = useState(false);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [projectScope, setProjectScope] = useState(false);
  const needsIdentityBasis = inviteRole === "reviewer" || inviteRole === "administrator";
  const eligibleProjects = inviteRole === "reviewer" ? projects : projects.filter(project => project.ownerOrganizationId === inviteOrg);
  const scopedProject = projectScope && inviteRole !== "" && inviteRole !== "administrator";
  const [changeSubject, setChangeSubject] = useState("");
  const [changeEmail, setChangeEmail] = useState("");
  const [changeReason, setChangeReason] = useState("");
  const [suspendSubject, setSuspendSubject] = useState("");
  const [suspendReason, setSuspendReason] = useState("");
  const [decisionReason, setDecisionReason] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const [invitationPage, changePage, suspensionPage] = await Promise.all([
        listInvitations(),
        listEmailChanges(),
        listSubjectSuspensions(),
      ]);
      setInvitations(invitationPage.items);
      setChanges(changePage.items);
      setSuspensions(suspensionPage.items);
      setError(null);
    } catch (caught) {
      setError(authErrorMessage(caught));
    }
  }, []);

  useEffect(() => {
    if (!token) return;
    void load();
    // The organisation list needs the project-creation role; without it the id is typed instead.
    listOrganizations(token)
      .then((page) => setOrganizations(page.items))
      .catch(() => setOrganizations([]));
  }, [token, load]);

  useEffect(() => {
    if (!token || !scopedProject) return;
    let active = true;
    listProjectItems(token, {}).then(page => {
      if (active) {
        setProjects(page.items);
        setProjectListIncomplete(page.truncated);
      }
    }).catch(() => {
      if (active) { setProjects([]); setProjectListIncomplete(true); }
    });
    return () => { active = false; };
  }, [token, scopedProject]);

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
      await onChanged();
    } catch (caught) {
      setError(authErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const people = subjects.filter((subject) => subject.kind === "person");
  const nameOf = (id: string) => subjects.find((subject) => subject.id === id)?.displayName ?? id.slice(0, 8);
  const decide = (id: string, decision: Decision["decision"]) => ({
    decision,
    reason: (decisionReason[id] ?? "").trim(),
  });

  const decisionControls = (
    id: string,
    onDecide: (input: Decision) => Promise<unknown>,
    approveAction: string,
  ) =>
    !can(session, approveAction) ? null : (
      <span className="row" style={{ display: "inline-flex" }}>
        <input
          aria-label={C.decisionReason}
          placeholder={C.decisionReason}
          value={decisionReason[id] ?? ""}
          onChange={(event) => setDecisionReason({ ...decisionReason, [id]: event.target.value })}
        />
        <button
          type="button"
          disabled={busy || !(decisionReason[id] ?? "").trim()}
          onClick={() => void act(() => onDecide(decide(id, "approve")))}
        >
          {C.approve}
        </button>
        <button
          type="button"
          disabled={busy || !(decisionReason[id] ?? "").trim()}
          onClick={() => void act(() => onDecide(decide(id, "reject")))}
        >
          {C.reject}
        </button>
      </span>
    );

  return (
    <>
      {error ? (
        <div className="notice" style={{ color: "var(--destructive-text)" }} role="alert" data-testid="account-admin-error">
          {error}
        </div>
      ) : null}

      {can(session, "admin.wallet.manage") && <WalletRecoveryPanel admin />}
      <details className="panel"><summary>Invite a person</summary>
      <div data-testid="admin-invitations">
        <h2>{C.invitations}</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          {C.invitationsLead}
        </p>
        <form
          className="invitation-form"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              await createInvitation(newIdempotencyKey(), {
                email: inviteEmail.trim(), organizationId: inviteOrg.trim(),
                ...(inviteRole ? { access: { role: inviteRole, identityBasis: needsIdentityBasis ? identityBasis.trim() : "Organisation membership attested by inviting administrator; mailbox verified at acceptance",
                  ...(scopedProject ? { projectId: inviteProject } : {}) } } : {}),
              });
              setIdentityBasis("");
              setInviteRole("project_member");
              setInviteProject("");
              setProjectScope(false);
              setInviteEmail("");
            });
          }}
        >
          <div className="field">
            <label htmlFor="invite-email">{AUTH_COPY.signIn.emailLabel}</label>
            <input id="invite-email" type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="invite-org">{C.organization}</label>
            {organizations.length > 0 ? (
              <select id="invite-org" value={inviteOrg} onChange={(event) => { setInviteOrg(event.target.value); setInviteProject(""); }}>
                <option value="">—</option>
                {organizations.map((organization) => (
                  <option key={organization.id} value={organization.id}>
                    {organization.legalName}
                  </option>
                ))}
              </select>
            ) : (
              <input id="invite-org" value={inviteOrg} onChange={(event) => { setInviteOrg(event.target.value); setInviteProject(""); }} />
            )}
          </div>
          <label className="field">Invitation role
            <select aria-label="Invitation role" value={inviteRole} onChange={event => { setInviteRole(event.target.value as InvitationRole | ""); setInviteProject(""); }}>
              {HUMAN_ROLES.map(role => <option key={role} value={role}>{HUMAN_ROLE_LABELS[role]}</option>)}
              <option value="">Account only</option>
            </select>
          </label>
          {inviteRole && inviteRole !== "administrator" && <label className="field">Access scope
            <select aria-label="Access scope" value={projectScope ? "project" : "organisation"} onChange={event => setProjectScope(event.target.value === "project")}>
              <option value="organisation">This organisation’s projects</option>
              <option value="project">One project</option>
            </select>
          </label>}
          {scopedProject && <label className="field">Project
            {projectListIncomplete ? <input required aria-label="Project" list="invite-project-options" placeholder="Project ID" value={inviteProject}
              onChange={event => setInviteProject(event.target.value)} /> : <select required aria-label="Project" value={inviteProject} onChange={event => setInviteProject(event.target.value)}>
              <option value="">Choose a project</option>
              {eligibleProjects.map(project =>
                <option key={project.id} value={project.id}>{project.name} · {project.projectKey}</option>)}
            </select>}
            {projectListIncomplete && <datalist id="invite-project-options">
              {eligibleProjects.map(project =>
                <option key={project.id} value={project.id}>{project.name} · {project.projectKey}</option>)}
            </datalist>}
          </label>}
          {needsIdentityBasis && <label className="field">How did you verify this person’s identity?
            <input required maxLength={1000} value={identityBasis} onChange={event => setIdentityBasis(event.target.value)} />
          </label>}
          {inviteRole === "administrator" && <span>Access to administer the entire workspace</span>}
          <button className="primary" type="submit" disabled={busy || !mayInvite || !inviteEmail.trim() || !inviteOrg.trim() || (needsIdentityBasis && !identityBasis.trim()) || (scopedProject && !inviteProject.trim())}>
            {C.invite}
          </button>
        </form>
        {invitations.length === 0 ? <p className="meta">{C.noInvitations}</p> : null}
        <ul data-testid="invitation-list">
          {invitations.map((invitation) => (
            <li key={invitation.id}>
              <span className="mono">{invitation.email}</span>{" "}
              {invitation.role && <span>{HUMAN_ROLE_LABELS[invitation.role]} · {invitation.projectId ? (projects.find(p => p.id === invitation.projectId)?.name ?? invitation.projectId) : invitation.role === "administrator" ? "Workspace" : "Organisation"} </span>}
              <span className="meta" data-testid="invitation-state">
                {invitation.closedReason
                  ? `· ${closed(invitation.closedReason)}`
                  : `· ${invitation.state} · expires ${invitation.expiresAt.slice(0, 16).replace("T", " ")}`}
              </span>{" "}
              {invitation.acceptedSubjectId ? <span>· {nameOf(invitation.acceptedSubjectId)} </span> : null}
              {invitation.state === "pending" && mayInvite ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void act(() => revokeInvitation(newIdempotencyKey(), invitation.id, invitation.version))}
                >
                  {C.revoke}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </div>

      </details>
      <details className="panel"><summary>Account recovery</summary>
      <div className="panel" data-testid="admin-email-changes">
        <h2>{C.emailChanges}</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          {C.emailChangesLead}
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              await createEmailChange(newIdempotencyKey(), {
                subjectId: changeSubject,
                newEmail: changeEmail.trim(),
                reason: changeReason.trim(),
              });
              setChangeEmail("");
              setChangeReason("");
            });
          }}
        >
          <div className="row" style={{ alignItems: "flex-end" }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="change-subject">{C.person}</label>
              <select id="change-subject" value={changeSubject} onChange={(event) => setChangeSubject(event.target.value)}>
                <option value="">—</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.displayName}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="change-email">{C.newEmail}</label>
              <input id="change-email" type="email" value={changeEmail} onChange={(event) => setChangeEmail(event.target.value)} />
            </div>
            <div className="field" style={{ marginBottom: 0, flex: 1 }}>
              <label htmlFor="change-reason">{C.reason}</label>
              <input id="change-reason" value={changeReason} onChange={(event) => setChangeReason(event.target.value)} />
            </div>
            <button
              className="primary"
              type="submit"
              disabled={busy || !mayProposeEmail || !changeSubject || !changeEmail.trim() || !changeReason.trim()}
            >
              {C.proposeEmailChange}
            </button>
          </div>
        </form>
        {changes.length === 0 ? <p className="meta">{C.noEmailChanges}</p> : null}
        <ul data-testid="email-change-list">
          {changes.map((change) => (
            <li key={change.id}>
              {nameOf(change.subjectId)} → <span className="mono">{change.newEmail}</span>{" "}
              <span className="meta" data-testid="email-change-state">
                · {change.closedReason ? closed(change.closedReason) : change.state} · {change.reason}
              </span>{" "}
              {change.state === "pending"
                ? decisionControls(change.id, (input) =>
                    decideEmailChange(newIdempotencyKey(), change.id, change.version, input),
                  "admin.email_change.approve")
                : null}
            </li>
          ))}
        </ul>
      </div>

      <div className="panel" data-testid="admin-suspensions">
        <h2>{C.suspensions}</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          {C.suspensionsLead}
        </p>
        <form onSubmit={(event) => event.preventDefault()}>
          <div className="row" style={{ alignItems: "flex-end" }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="suspend-subject">{C.person}</label>
              <select id="suspend-subject" value={suspendSubject} onChange={(event) => setSuspendSubject(event.target.value)}>
                <option value="">—</option>
                {people.filter((subject) => subject.id !== session?.subjectId).map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.displayName}
                    {person.suspendedAt ? ` (${C.suspended})` : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ marginBottom: 0, flex: 1 }}>
              <label htmlFor="suspend-reason">{C.reason}</label>
              <input id="suspend-reason" value={suspendReason} onChange={(event) => setSuspendReason(event.target.value)} />
            </div>
            {(["suspend", "reinstate"] as const).map((action) => (
              <button
                key={action}
                type="button"
                className={action === "suspend" ? "primary" : undefined}
                disabled={busy || !mayProposeSuspension || !suspendSubject || !suspendReason.trim()}
                onClick={() =>
                  void act(async () => {
                    await createSubjectSuspension(newIdempotencyKey(), {
                      subjectId: suspendSubject,
                      action,
                      reason: suspendReason.trim(),
                    });
                    setSuspendReason("");
                  })
                }
              >
                {action === "suspend" ? C.suspend : C.reinstate}
              </button>
            ))}
          </div>
        </form>
        {suspensions.length === 0 ? <p className="meta">{C.noSuspensions}</p> : null}
        <ul data-testid="suspension-list">
          {suspensions.map((suspension) => (
            <li key={suspension.id}>
              {suspension.subjectName}{" "}
              <span className="meta">
                · {C.suspensionAction[suspension.action] ?? suspension.action} ·{" "}
                {suspension.closedReason ? closed(suspension.closedReason) : suspension.state} · {suspension.reason}
              </span>
{" "}
              {suspension.state === "pending"
                ? decisionControls(suspension.id, (input) =>
                    decideSubjectSuspension(newIdempotencyKey(), suspension.id, suspension.version, input),
                  "admin.subject_suspension.approve")
                : null}
            </li>
          ))}
        </ul>
      </div>
      </details>
    </>
  );
}
