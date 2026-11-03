"use client";

import { useCallback, useEffect, useState } from "react";
import {
  createEmailChange,
  createInvitation,
  createMfaReset,
  createSubjectSuspension,
  decideEmailChange,
  decideMfaReset,
  decideSubjectSuspension,
  listEmailChanges,
  listInvitations,
  listMfaResets,
  listSubjectSuspensions,
  revokeInvitation,
  type Decision,
  type EmailChange,
  type Invitation,
  type MfaReset,
  type SubjectSuspension,
} from "@/lib/account-api";
import { listOrganizations, newIdempotencyKey, type AdminSubject, type OrganizationOption } from "@/lib/api";
import { authErrorMessage } from "@/lib/auth-errors";
import { AUTH_COPY } from "@/lib/copy";
import { useSession } from "@/lib/session";
import { can } from "@/lib/access";
import { StepUpCancelled, useOptionalStepUp } from "@/components/auth/StepUp";

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
  // An auditor reads these lists (`admin.read`) but changes nothing: each control needs its own
  // action. Guidance only; the server decides.
  const mayInvite = can(session, "admin.invitation.manage");
  const mayProposeEmail = can(session, "admin.email_change.propose");
  const mayProposeReset = can(session, "admin.mfa_reset.propose");
  const mayProposeSuspension = can(session, "admin.subject_suspension.propose");
  const stepUp = useOptionalStepUp();
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [changes, setChanges] = useState<EmailChange[]>([]);
  const [resets, setResets] = useState<MfaReset[]>([]);
  const [suspensions, setSuspensions] = useState<SubjectSuspension[]>([]);
  const [organizations, setOrganizations] = useState<OrganizationOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteOrg, setInviteOrg] = useState("");
  const [changeSubject, setChangeSubject] = useState("");
  const [changeEmail, setChangeEmail] = useState("");
  const [changeReason, setChangeReason] = useState("");
  const [resetSubject, setResetSubject] = useState("");
  const [resetReason, setResetReason] = useState("");
  const [suspendSubject, setSuspendSubject] = useState("");
  const [suspendReason, setSuspendReason] = useState("");
  const [decisionReason, setDecisionReason] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const [invitationPage, changePage, resetPage, suspensionPage] = await Promise.all([
        listInvitations(),
        listEmailChanges(),
        listMfaResets(),
        listSubjectSuspensions(),
      ]);
      setInvitations(invitationPage.items);
      setChanges(changePage.items);
      setResets(resetPage.items);
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

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await (stepUp ? stepUp.run(action) : action());
      await load();
      await onChanged();
    } catch (caught) {
      if (!(caught instanceof StepUpCancelled)) setError(authErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const people = subjects.filter((subject) => subject.kind === "person" && subject.id !== session?.subjectId);
  const nameOf = (id: string) => subjects.find((subject) => subject.id === id)?.displayName ?? id.slice(0, 8);
  const decide = (id: string, decision: Decision["decision"]) => ({
    decision,
    reason: (decisionReason[id] ?? "").trim(),
  });

  const decisionControls = (
    id: string,
    proposer: string,
    onDecide: (input: Decision) => Promise<unknown>,
    approveAction: string,
  ) =>
    !can(session, approveAction) ? null : proposer === session?.subjectId ? (
      <span className="meta">waiting for another administrator</span>
    ) : (
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

      <div className="panel" data-testid="admin-invitations">
        <h2>{C.invitations}</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          {C.invitationsLead}
        </p>
        <form
          className="row"
          style={{ alignItems: "flex-end" }}
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              await createInvitation(newIdempotencyKey(), { email: inviteEmail.trim(), organizationId: inviteOrg.trim() });
              setInviteEmail("");
            });
          }}
        >
          <div className="field" style={{ marginBottom: 0, flex: 1, minWidth: 220 }}>
            <label htmlFor="invite-email">{AUTH_COPY.signIn.emailLabel}</label>
            <input id="invite-email" type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="invite-org">{C.organization}</label>
            {organizations.length > 0 ? (
              <select id="invite-org" value={inviteOrg} onChange={(event) => setInviteOrg(event.target.value)}>
                <option value="">—</option>
                {organizations.map((organization) => (
                  <option key={organization.id} value={organization.id}>
                    {organization.legalName}
                  </option>
                ))}
              </select>
            ) : (
              <input id="invite-org" value={inviteOrg} onChange={(event) => setInviteOrg(event.target.value)} />
            )}
          </div>
          <button className="primary" type="submit" disabled={busy || !mayInvite || !inviteEmail.trim() || !inviteOrg.trim()}>
            {C.invite}
          </button>
        </form>
        {invitations.length === 0 ? <p className="meta">{C.noInvitations}</p> : null}
        <ul data-testid="invitation-list">
          {invitations.map((invitation) => (
            <li key={invitation.id}>
              <span className="mono">{invitation.email}</span>{" "}
              <span className="meta" data-testid="invitation-state">
                {invitation.closedReason
                  ? `· ${closed(invitation.closedReason)}`
                  : `· ${invitation.state} · expires ${invitation.expiresAt.slice(0, 16).replace("T", " ")}`}
              </span>{" "}
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
                ? decisionControls(change.id, change.requestedBySubjectId, (input) =>
                    decideEmailChange(newIdempotencyKey(), change.id, change.version, input),
                  "admin.email_change.approve")
                : null}
            </li>
          ))}
        </ul>
      </div>

      <div className="panel" data-testid="admin-mfa-resets">
        <h2>{C.mfaResets}</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          {C.mfaResetsLead}
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              await createMfaReset(newIdempotencyKey(), { subjectId: resetSubject, reason: resetReason.trim() });
              setResetReason("");
            });
          }}
        >
          <div className="row" style={{ alignItems: "flex-end" }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="reset-subject">{C.person}</label>
              <select id="reset-subject" value={resetSubject} onChange={(event) => setResetSubject(event.target.value)}>
                <option value="">—</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.displayName}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ marginBottom: 0, flex: 1 }}>
              <label htmlFor="reset-reason">{C.reason}</label>
              <input id="reset-reason" value={resetReason} onChange={(event) => setResetReason(event.target.value)} />
            </div>
            <button className="primary" type="submit" disabled={busy || !mayProposeReset || !resetSubject || !resetReason.trim()}>
              {C.proposeMfaReset}
            </button>
          </div>
        </form>
        {resets.length === 0 ? <p className="meta">{C.noMfaResets}</p> : null}
        <ul data-testid="mfa-reset-list">
          {resets.map((reset) => (
            <li key={reset.id}>
              {reset.subjectName}{" "}
              <span className="meta" data-testid="mfa-reset-state">
                · {reset.closedReason ? closed(reset.closedReason) : reset.state} · {reset.reason}
              </span>
              {/* A closed reset has no open window, even one approved with a time still ahead. */}
              {reset.enrolmentWindowUntil && !reset.closedReason ? (
                <span className="meta"> · {C.windowUntil(reset.enrolmentWindowUntil.slice(0, 16).replace("T", " "))}</span>
              ) : null}{" "}
              {reset.state === "pending"
                ? decisionControls(reset.id, reset.requestedBySubjectId, (input) =>
                    decideMfaReset(newIdempotencyKey(), reset.id, reset.version, input),
                  "admin.mfa_reset.approve")
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
                {people.map((person) => (
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
              {suspension.enrolmentWindowUntil && !suspension.closedReason ? (
                <span className="meta"> · {C.windowUntil(suspension.enrolmentWindowUntil.slice(0, 16).replace("T", " "))}</span>
              ) : null}{" "}
              {suspension.state === "pending"
                ? decisionControls(suspension.id, suspension.requestedBySubjectId, (input) =>
                    decideSubjectSuspension(newIdempotencyKey(), suspension.id, suspension.version, input),
                  "admin.subject_suspension.approve")
                : null}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
