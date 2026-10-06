"use client";

import { useCallback, useEffect, useState } from "react";
import {
  bindAdminWallet,
  createNotificationSink,
  listNotificationSinks,
  NOTIFICATION_DELIVERY_ERROR_TEXT,
  updateNotificationSinkState,
  type NotificationSink,
  createAdminSubject,
  createRoleGrant,
  createRoleRevocation,
  decideRoleGrant,
  decideRoleRevocation,
  disableAdminWallet,
  listAdminSubjects,
  listRoleGrants,
  listRoleRevocations,
  newIdempotencyKey,
  createDocumentLinkRule,
  listDocumentLinkRules,
  retireDocumentLinkRule,
  type AdminSubject,
  type DocumentLinkKind,
  type DocumentLinkRule,
  type RoleGrant,
  type RoleRevocation,
  type RoleRevocationReasonCode,
} from "@/lib/api";
import { KIND_EXPLANATION } from "@/lib/documents";
import { useSession } from "@/lib/session";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Address } from "@/components/Address";

/**
 * Administration — spec 11 §11.2.
 *
 * Before this screen, the only way to add a person to a deployed system was to run the
 * `bootstrap` CLI on the server. That CLI runs over a superuser connection that bypasses
 * RLS.
 *
 * **No one can grant a role alone, and that shapes this screen.** A role grant splits into
 * "proposal" and "decision", and the proposer never sees the decision buttons.
 * The server blocks the same thing — hiding a button is not a security control (02 §2.1).
 *
 * **Locked accounts come first.** If every attached wallet is inactive, the person cannot
 * sign in whatever their role. Mixed into the list, that state goes unnoticed.
 */

const REASON_CODES = [
  { value: "key_lost", label: "Key lost" },
  { value: "key_compromised", label: "Key compromised" },
  { value: "rotation", label: "Planned rotation" },
  { value: "offboarding", label: "Offboarding" },
] as const;

/** Why a role is taken back. Same codes as the server's `ROLE_REVOCATION_REASON_CODES`. */
const REVOCATION_REASONS: readonly { value: RoleRevocationReasonCode; label: string }[] = [
  { value: "offboarding", label: "Offboarding" },
  { value: "duty_change", label: "Duty changed" },
  { value: "security_concern", label: "Security concern" },
  { value: "granted_in_error", label: "Granted in error" },
];

/** Roles that can approve a role grant. Same list as the server's `admin.role.approve`. */
const ADMIN_ROLES: readonly string[] = ["mpc_operator", "security_operator"];

/**
 * Assurance levels a bind may carry. Same values as the server's `bindWalletRequest`.
 *
 * No default is preselected. The level decides which roles the wallet can exercise, so it is a
 * deliberate choice with a stated basis, not a value that rides along with the address.
 */
const ASSURANCE_OPTIONS = [
  { value: "wallet_only", label: "Wallet only — public read and voting" },
  { value: "identity_bound", label: "Identity bound — steward, proposer, project roles" },
  { value: "high_assurance", label: "High assurance — reviewer, gate approver, operator roles" },
] as const;

/** A binding someone is about to propose revoking. */
interface RevokeTarget {
  readonly bindingId: string;
  readonly subjectName: string;
  readonly role: string;
}

export default function AdminPage() {
  const { token, session, loading: sessionLoading } = useSession();
  const [subjects, setSubjects] = useState<AdminSubject[]>([]);
  const [grants, setGrants] = useState<RoleGrant[]>([]);
  const [revocations, setRevocations] = useState<RoleRevocation[]>([]);
  const [sinks, setSinks] = useState<NotificationSink[]>([]);
  const [sinkUrl, setSinkUrl] = useState("");
  const [sinkSecret, setSinkSecret] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(true);

  const [newName, setNewName] = useState("");
  const [walletFor, setWalletFor] = useState<string | null>(null);
  const [walletAddress, setWalletAddress] = useState("");
  const [walletLevel, setWalletLevel] = useState("");
  const [walletJustification, setWalletJustification] = useState("");
  const [disableFor, setDisableFor] = useState<{ id: string; version: number } | null>(null);
  const [reasonCode, setReasonCode] = useState<string>("key_lost");
  const [detail, setDetail] = useState("");
  const [grantFor, setGrantFor] = useState<string | null>(null);
  const [grantRole, setGrantRole] = useState("");
  const [grantReason, setGrantReason] = useState("");
  const [revokeFor, setRevokeFor] = useState<RevokeTarget | null>(null);
  const [revokeCode, setRevokeCode] = useState<RoleRevocationReasonCode>("offboarding");
  const [revokeReason, setRevokeReason] = useState("");
  const [rules, setRules] = useState<DocumentLinkRule[]>([]);
  const [ruleUpstream, setRuleUpstream] = useState("");
  const [ruleDownstream, setRuleDownstream] = useState("");
  const [ruleKind, setRuleKind] = useState<DocumentLinkKind>("depends_on");
  const [ruleNote, setRuleNote] = useState("");
  const [ruleResult, setRuleResult] = useState<string | null>(null);
  const [retireFor, setRetireFor] = useState<string | null>(null);
  const [retireNote, setRetireNote] = useState("");

  const reload = useCallback(async () => {
    if (!token) return;
    setBusy(true);
    try {
      const [subjectPage, grantPage, revocationPage, sinkPage, rulePage] = await Promise.all([
        listAdminSubjects(token),
        listRoleGrants(token),
        listRoleRevocations(token),
        listNotificationSinks(token),
        listDocumentLinkRules(token),
      ]);
      setSubjects(subjectPage.items);
      setGrants(grantPage.items);
      setRevocations(revocationPage.items);
      setSinks(sinkPage.items);
      setRules(rulePage.items);
      setError(null);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }, [token]);

  useEffect(() => {
    if (sessionLoading) return;
    void reload();
  }, [reload, sessionLoading]);

  async function run(action: () => Promise<unknown>) {
    try {
      await action();
      await reload();
      setError(null);
    } catch (caught) {
      setError(caught);
    }
  }

  const locked = subjects.filter((subject) => subject.locked);
  const pending = grants.filter((grant) => grant.state === "pending");
  const pendingRevocations = revocations.filter((revocation) => revocation.state === "pending");
  // A binding with an open proposal gets no second button — the server would refuse it (409).
  const bindingsUnderRevocation = new Set(pendingRevocations.map((item) => item.roleBindingId));

  if (!sessionLoading && !session?.authenticated) {
    return <p className="sub">No account is connected.</p>;
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Administration</h1>
          <p className="sub">
            People, wallets, and roles for this tenant. Granting or revoking a role takes two
            people: one proposes, another decides. The server enforces that — hiding a button is
            not a control.
          </p>
        </div>
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      {locked.length > 0 ? (
        <div className="notice" style={{ color: "var(--alert)" }} data-testid="admin-locked">
          <div className="title">
            {locked.length} account{locked.length === 1 ? "" : "s"} cannot sign in
          </div>
          Every wallet bound to {locked.map((subject) => subject.displayName).join(", ")} is
          disabled. Roles remain recorded, but the person has no way in until a new key is bound.
        </div>
      ) : null}

      <div className="panel">
        <h2>Add a person</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          A new subject has no wallet and no role. Both are separate, deliberate steps.
        </p>
        <form
          className="row"
          style={{ alignItems: "flex-end" }}
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await createAdminSubject(token!, newIdempotencyKey(), { displayName: newName });
              setNewName("");
            });
          }}
        >
          <div className="field" style={{ marginBottom: 0, flex: 1, minWidth: 220 }}>
            <label htmlFor="subject-name">Name</label>
            <input
              id="subject-name"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
          </div>
          <button className="primary" type="submit" disabled={busy || newName.trim() === ""}>
            Add person
          </button>
        </form>
      </div>

      <div className="panel">
        <h2>People</h2>
        <div className="table-scroll">
          <table data-testid="admin-subjects">
            <thead>
              <tr>
                <th>Name</th>
                <th>Wallets</th>
                <th>Roles</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {subjects.map((subject) => (
                <tr key={subject.id}>
                  <td>
                    {subject.displayName}
                    {subject.locked ? (
                      <div className="meta" style={{ color: "var(--destructive-text)" }}>
                        cannot sign in
                      </div>
                    ) : null}
                  </td>
                  <td className="mono meta">
                    {subject.wallets.length === 0 ? "none" : null}
                    {subject.wallets.map((wallet) => (
                      <div key={wallet.id}>
                        <Address value={wallet.walletAddress} />{" "}
                        <span data-testid="wallet-assurance">{wallet.assuranceLevel}</span>{" "}
                        {wallet.disabledAt ? (
                          <span style={{ color: "var(--destructive-text)" }}>disabled</span>
                        ) : wallet.walletAddress === session?.walletAddress?.toLowerCase() ? (
                          // You cannot deactivate your own wallet. A button here would show the rejection only after the click.
                          <span>you</span>
                        ) : (
                          <button
                            onClick={() => setDisableFor({ id: wallet.id, version: wallet.version })}
                          >
                            Disable
                          </button>
                        )}
                      </div>
                    ))}
                  </td>
                  <td className="mono meta">
                    {subject.roles.length === 0 ? "none" : null}
                    {subject.roles.map((role) => (
                      <div key={role.id}>
                        {role.role}{" "}
                        {role.revokedAt ? (
                          // Ended, not deleted — the history of who held what stays visible.
                          <span style={{ color: "var(--destructive-text)" }}>revoked</span>
                        ) : bindingsUnderRevocation.has(role.id) ? (
                          <span>revocation pending</span>
                        ) : (
                          <button
                            onClick={() =>
                              setRevokeFor({
                                bindingId: role.id,
                                subjectName: subject.displayName,
                                role: role.role,
                              })
                            }
                          >
                            Propose revocation
                          </button>
                        )}
                      </div>
                    ))}
                  </td>
                  <td>
                    {/* Operator-level holders do not get wallets attached from the screen. Key rotation goes through bootstrap. */}
                    {subject.roles.some(
                      (role) => role.revokedAt === null && ADMIN_ROLES.includes(role.role),
                    ) ? (
                      <span className="meta">Wallet changes via bootstrap</span>
                    ) : (
                      <button onClick={() => setWalletFor(subject.id)}>Bind wallet</button>
                    )}{" "}
                    <button onClick={() => setGrantFor(subject.id)}>Propose role</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {walletFor ? (
        <div className="panel">
          <h2>Bind a wallet</h2>
          <p className="sub" style={{ marginTop: 0 }}>
            This is also the recovery path: disable the lost key, then bind a new address here. An
            address already bound elsewhere is refused rather than moved — moving it would make that
            address&rsquo;s past signatures read as someone else&rsquo;s.
          </p>
          <p className="sub" style={{ marginTop: 0 }}>
            The assurance level decides which roles this wallet can exercise. Choose it from what you
            checked about the person, and say what that was — it is kept in the audit record.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                // Use the server session's chain. A hardcoded number breaks on stg/prod (56).
                if (!session?.chainId) throw new Error("No session chain. Connect again.");
                await bindAdminWallet(token!, newIdempotencyKey(), walletFor, {
                  walletAddress: walletAddress.trim().toLowerCase(),
                  chainId: session.chainId,
                  assuranceLevel: walletLevel,
                  justification: walletJustification.trim(),
                });
                setWalletFor(null);
                setWalletAddress("");
                setWalletLevel("");
                setWalletJustification("");
              });
            }}
          >
            <div className="field">
              <label htmlFor="wallet-address">Wallet address</label>
              <input
                id="wallet-address"
                className="mono"
                value={walletAddress}
                onChange={(event) => setWalletAddress(event.target.value)}
                placeholder="0x…"
              />
            </div>
            <div className="field">
              <label htmlFor="wallet-assurance">Assurance level</label>
              <select
                id="wallet-assurance"
                value={walletLevel}
                onChange={(event) => setWalletLevel(event.target.value)}
              >
                <option value="">Choose a level</option>
                {ASSURANCE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="wallet-justification">What you checked (required)</label>
              <input
                id="wallet-justification"
                value={walletJustification}
                onChange={(event) => setWalletJustification(event.target.value)}
                placeholder="e.g. ID document checked in person"
              />
            </div>
            <button
              className="primary"
              type="submit"
              disabled={
                walletAddress.trim() === "" ||
                walletLevel === "" ||
                walletJustification.trim() === ""
              }
            >
              Bind
            </button>{" "}
            <button type="button" onClick={() => setWalletFor(null)}>
              Cancel
            </button>
          </form>
        </div>
      ) : null}

      {disableFor ? (
        <div className="panel">
          <h2>Disable a wallet</h2>
          <p className="sub" style={{ marginTop: 0 }}>
            The reason is recorded because lost, compromised, rotated, and offboarded produce the
            same result but call for different readings of that key&rsquo;s past signatures. Past
            signatures are not removed.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await disableAdminWallet(
                  token!,
                  newIdempotencyKey(),
                  disableFor.id,
                  disableFor.version,
                  { reasonCode, detail },
                );
                setDisableFor(null);
                setDetail("");
              });
            }}
          >
            <div className="field">
              <label htmlFor="reason-code">Reason</label>
              <select
                id="reason-code"
                value={reasonCode}
                onChange={(event) => setReasonCode(event.target.value)}
              >
                {REASON_CODES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="reason-detail">What happened</label>
              <input
                id="reason-detail"
                value={detail}
                onChange={(event) => setDetail(event.target.value)}
              />
            </div>
            <button className="primary" type="submit" disabled={detail.trim() === ""}>
              Disable
            </button>{" "}
            <button type="button" onClick={() => setDisableFor(null)}>
              Cancel
            </button>
          </form>
        </div>
      ) : null}

      {grantFor ? (
        <div className="panel">
          <h2>Propose a role</h2>
          <p className="sub" style={{ marginTop: 0 }}>
            Proposing does not grant. Someone else has to decide, and it cannot be you.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await createRoleGrant(token!, newIdempotencyKey(), {
                  subjectId: grantFor,
                  role: grantRole.trim(),
                  reason: grantReason,
                });
                setGrantFor(null);
                setGrantRole("");
                setGrantReason("");
              });
            }}
          >
            <div className="field">
              <label htmlFor="grant-role">Role</label>
              <input
                id="grant-role"
                className="mono"
                value={grantRole}
                onChange={(event) => setGrantRole(event.target.value)}
                placeholder="data_steward"
              />
            </div>
            <div className="field">
              <label htmlFor="grant-reason">Why</label>
              <input
                id="grant-reason"
                value={grantReason}
                onChange={(event) => setGrantReason(event.target.value)}
              />
            </div>
            <button
              className="primary"
              type="submit"
              disabled={grantRole.trim() === "" || grantReason.trim() === ""}
            >
              Propose
            </button>{" "}
            <button type="button" onClick={() => setGrantFor(null)}>
              Cancel
            </button>
          </form>
        </div>
      ) : null}

      {revokeFor ? (
        <div className="panel">
          <h2>Propose a revocation</h2>
          <p className="sub" style={{ marginTop: 0 }}>
            Revoke <span className="mono">{revokeFor.role}</span> from {revokeFor.subjectName}.
            Proposing does not revoke. Someone else has to decide, and it cannot be you. The role
            is ended, not deleted: the record of who held it stays.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await createRoleRevocation(token!, newIdempotencyKey(), {
                  roleBindingId: revokeFor.bindingId,
                  reasonCode: revokeCode,
                  reason: revokeReason,
                });
                setRevokeFor(null);
                setRevokeReason("");
              });
            }}
          >
            <div className="field">
              <label htmlFor="revoke-reason-code">Revocation reason</label>
              <select
                id="revoke-reason-code"
                value={revokeCode}
                onChange={(event) => setRevokeCode(event.target.value as RoleRevocationReasonCode)}
              >
                {REVOCATION_REASONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="revoke-detail">What changed</label>
              <input
                id="revoke-detail"
                value={revokeReason}
                onChange={(event) => setRevokeReason(event.target.value)}
              />
            </div>
            <button className="primary" type="submit" disabled={revokeReason.trim() === ""}>
              Submit revocation
            </button>{" "}
            <button type="button" onClick={() => setRevokeFor(null)}>
              Cancel
            </button>
          </form>
        </div>
      ) : null}

      {/*
        Document type rules.

        A rule writes links into every project of the tenant, which is why the server gives it
        to a tenant-wide role only. Retiring keeps the links already made — people may have come
        to rely on them — so the screen says that before the button, not after.
      */}
      <div className="panel" data-testid="admin-document-rules">
        <h2>Document type rules</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          &ldquo;Documents of one type rest on documents of another.&rdquo; A rule links the
          current documents of every project now, and each document later given a matching type.
          People can still add and remove links themselves; types match regardless of case.
        </p>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const created = await createDocumentLinkRule(
                token!,
                {
                  upstreamType: ruleUpstream.trim(),
                  downstreamType: ruleDownstream.trim(),
                  kind: ruleKind,
                  note: ruleNote.trim() === "" ? null : ruleNote.trim(),
                },
                newIdempotencyKey(),
              );
              setRuleResult(
                `Rule added. It linked ${created.linksCreated} existing document pair${
                  created.linksCreated === 1 ? "" : "s"
                }.`,
              );
              setRuleUpstream("");
              setRuleDownstream("");
              setRuleNote("");
            });
          }}
        >
          <div className="row" style={{ alignItems: "flex-end" }}>
            <div className="field" style={{ marginBottom: 0, flex: 1, minWidth: 200 }}>
              <label htmlFor="rule-downstream">Documents of type</label>
              <input
                id="rule-downstream"
                value={ruleDownstream}
                maxLength={80}
                placeholder="Drilling report"
                onChange={(event) => setRuleDownstream(event.target.value)}
              />
            </div>
            <div className="field" style={{ marginBottom: 0, flex: 1, minWidth: 200 }}>
              <label htmlFor="rule-upstream">rest on documents of type</label>
              <input
                id="rule-upstream"
                value={ruleUpstream}
                maxLength={80}
                placeholder="Exploration license"
                onChange={(event) => setRuleUpstream(event.target.value)}
              />
            </div>
          </div>
          <div className="field" style={{ marginTop: 12 }}>
            <label htmlFor="rule-kind">Kind</label>
            <select
              id="rule-kind"
              value={ruleKind}
              onChange={(event) => setRuleKind(event.target.value as DocumentLinkKind)}
            >
              <option value="depends_on">{KIND_EXPLANATION.depends_on}</option>
              <option value="references">{KIND_EXPLANATION.references}</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="rule-note">Note (optional)</label>
            <input
              id="rule-note"
              value={ruleNote}
              maxLength={500}
              onChange={(event) => setRuleNote(event.target.value)}
            />
          </div>
          <button
            className="primary"
            type="submit"
            disabled={busy || ruleUpstream.trim() === "" || ruleDownstream.trim() === ""}
          >
            Add rule
          </button>
        </form>
        {ruleResult ? (
          <p className="meta" data-testid="rule-result">
            {ruleResult}
          </p>
        ) : null}

        {rules.length === 0 ? (
          <p className="sub" style={{ margin: "12px 0 0" }}>
            No rule is declared. Documents are linked only by the people who work with them.
          </p>
        ) : (
          <div className="table-scroll" style={{ marginTop: 12 }}>
            <table>
              <thead>
                <tr>
                  <th>Documents of type</th>
                  <th>Rest on type</th>
                  <th>Kind</th>
                  <th>Note</th>
                  <th>State</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <tr key={rule.id}>
                    <td>{rule.downstreamType}</td>
                    <td>{rule.upstreamType}</td>
                    <td className="mono meta">{rule.kind}</td>
                    <td className="meta">{rule.note ?? "—"}</td>
                    <td className="meta">
                      {rule.retiredAt ? (
                        <>
                          retired {rule.retiredAt.slice(0, 10)}
                          {rule.retirementNote ? <div>{rule.retirementNote}</div> : null}
                        </>
                      ) : (
                        "active"
                      )}
                    </td>
                    <td>
                      {rule.retiredAt ? null : (
                        <button onClick={() => setRetireFor(rule.id)}>Retire</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {retireFor ? (
          <form
            style={{ marginTop: 12 }}
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await retireDocumentLinkRule(
                  token!,
                  retireFor,
                  retireNote.trim(),
                  newIdempotencyKey(),
                );
                setRetireFor(null);
                setRetireNote("");
              });
            }}
          >
            <p className="sub" style={{ marginTop: 0 }}>
              Retiring stops new links. The links this rule already made stay, and people can
              remove them one by one.
            </p>
            <div className="field">
              <label htmlFor="retire-note">Why</label>
              <input
                id="retire-note"
                value={retireNote}
                maxLength={500}
                onChange={(event) => setRetireNote(event.target.value)}
              />
            </div>
            <button className="primary" type="submit" disabled={retireNote.trim() === ""}>
              Retire rule
            </button>{" "}
            <button type="button" onClick={() => setRetireFor(null)}>
              Cancel
            </button>
          </form>
        ) : null}
      </div>

      {/*
        Notification sinks.

        **Show "registered" separately from "actually delivering".** A sink that is configured but
        sends nothing is the worst state — everyone believes it is sending.
      */}
      <div className="panel" data-testid="admin-sinks">
        <h2>Notification delivery</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          Notifications reach people inside this app whether or not anything is configured here. A
          sink pushes them out as well, signed so the receiver can tell they came from this
          registry. Email is deliberately not offered — storing addresses would make this system
          hold personal data it currently refuses (OD-18).
        </p>

        <form
          className="row"
          style={{ alignItems: "flex-end" }}
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await createNotificationSink(token!, newIdempotencyKey(), {
                url: sinkUrl.trim(),
                secretReference: sinkSecret.trim(),
              });
              setSinkUrl("");
              setSinkSecret("");
            });
          }}
        >
          <div className="field" style={{ marginBottom: 0, flex: 1, minWidth: 220 }}>
            <label htmlFor="sink-url">Webhook URL</label>
            <input
              id="sink-url"
              className="mono"
              value={sinkUrl}
              placeholder="https://…"
              onChange={(event) => setSinkUrl(event.target.value)}
            />
          </div>
          <div className="field" style={{ marginBottom: 0, flex: 1, minWidth: 200 }}>
            <label htmlFor="sink-secret">Signing secret reference</label>
            <input
              id="sink-secret"
              className="mono"
              value={sinkSecret}
              placeholder="file:/run/secrets/webhook_hmac"
              onChange={(event) => setSinkSecret(event.target.value)}
            />
          </div>
          <button
            className="primary"
            type="submit"
            disabled={sinkUrl.trim() === "" || sinkSecret.trim() === ""}
          >
            Add sink
          </button>
        </form>
        <p className="meta">
          {/* A pasted value would stay in the DB. Accept only a reference (05 §5.12). */}
          A reference, not the secret itself — `env:WEBHOOK_SECRET_&lt;NAME&gt;` or
          `file:/run/secrets/webhook_&lt;name&gt;`. The worker resolves it at send time; the value
          never enters this database. Private and internal addresses are refused.
        </p>

        {sinks.length === 0 ? (
          <p className="sub" style={{ margin: 0 }}>
            No sink is configured. Notifications stay inside the app — someone has to open it.
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>URL</th>
                  <th>State</th>
                  <th>Delivered</th>
                  <th>Pending</th>
                  <th>Failed</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sinks.map((sink) => (
                  <tr key={sink.id}>
                    <td className="mono">{sink.url}</td>
                    <td className="mono">{sink.state}</td>
                    <td className="mono">{sink.delivery.delivered}</td>
                    <td className="mono">{sink.delivery.pending}</td>
                    <td className="mono">
                      {sink.delivery.failed > 0 ? (
                        <span style={{ color: "var(--destructive-text)" }}>{sink.delivery.failed}</span>
                      ) : (
                        0
                      )}
                      {sink.delivery.lastError ? (
                        <div className="meta">
                          {NOTIFICATION_DELIVERY_ERROR_TEXT[sink.delivery.lastError]}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      {/* Pause, do not delete. Deleting loses why it was cut off. */}
                      <button
                        onClick={() =>
                          void run(() =>
                            updateNotificationSinkState(
                              token!,
                              newIdempotencyKey(),
                              sink.id,
                              sink.version,
                              sink.state === "active" ? "paused" : "active",
                            ),
                          )
                        }
                      >
                        {sink.state === "active" ? "Pause" : "Resume"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <h2>Role proposals waiting on a decision</h2>
        {pending.length === 0 ? (
          <p className="sub" style={{ margin: 0 }}>
            Nothing is waiting. This is not a permission problem.
          </p>
        ) : (
          <div className="table-scroll">
            <table data-testid="admin-role-grants">
              <thead>
                <tr>
                  <th>Who</th>
                  <th>Role</th>
                  <th>Why</th>
                  <th>Decision</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((grant) => {
                  const mine = grant.requestedBySubjectId === session?.subjectId;
                  return (
                    <tr key={grant.id}>
                      <td>{grant.subjectName}</td>
                      <td className="mono">{grant.role}</td>
                      <td style={{ color: "var(--muted-foreground)" }}>{grant.reason}</td>
                      <td>
                        {/*
                          The proposer gets no decision buttons. The server blocks the
                          same thing, but a clickable button that is always rejected makes
                          the screen look broken.
                        */}
                        {mine ? (
                          <span className="meta">You proposed this — someone else decides.</span>
                        ) : (
                          <>
                            <button
                              className="primary"
                              onClick={() =>
                                void run(() =>
                                  decideRoleGrant(
                                    token!,
                                    newIdempotencyKey(),
                                    grant.id,
                                    grant.version,
                                    { decision: "approve", reason: "Reviewed and approved" },
                                  ),
                                )
                              }
                            >
                              Approve
                            </button>{" "}
                            <button
                              onClick={() =>
                                void run(() =>
                                  decideRoleGrant(
                                    token!,
                                    newIdempotencyKey(),
                                    grant.id,
                                    grant.version,
                                    { decision: "reject", reason: "Not needed for this role" },
                                  ),
                                )
                              }
                            >
                              Reject
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <h2>Role revocations waiting on a decision</h2>
        {pendingRevocations.length === 0 ? (
          <p className="sub" style={{ margin: 0 }}>
            Nothing is waiting. This is not a permission problem.
          </p>
        ) : (
          <div className="table-scroll">
            <table data-testid="admin-role-revocations">
              <thead>
                <tr>
                  <th>Who</th>
                  <th>Role</th>
                  <th>Reason</th>
                  <th>Why</th>
                  <th>Decision</th>
                </tr>
              </thead>
              <tbody>
                {pendingRevocations.map((revocation) => (
                  <tr key={revocation.id}>
                    <td>{revocation.subjectName}</td>
                    <td className="mono">{revocation.role}</td>
                    <td className="meta">
                      {REVOCATION_REASONS.find((option) => option.value === revocation.reasonCode)
                        ?.label ?? revocation.reasonCode}
                    </td>
                    <td style={{ color: "var(--muted-foreground)" }}>{revocation.reason}</td>
                    <td>
                      {/* Same as grants: the proposer gets no decision buttons. The server blocks it too. */}
                      {revocation.requestedBySubjectId === session?.subjectId ? (
                        <span className="meta">You proposed this — someone else decides.</span>
                      ) : (
                        <>
                          <button
                            className="primary"
                            onClick={() =>
                              void run(() =>
                                decideRoleRevocation(
                                  token!,
                                  newIdempotencyKey(),
                                  revocation.id,
                                  revocation.version,
                                  { decision: "approve", reason: "Reviewed and approved" },
                                ),
                              )
                            }
                          >
                            Approve
                          </button>{" "}
                          <button
                            onClick={() =>
                              void run(() =>
                                decideRoleRevocation(
                                  token!,
                                  newIdempotencyKey(),
                                  revocation.id,
                                  revocation.version,
                                  { decision: "reject", reason: "The role is still needed" },
                                ),
                              )
                            }
                          >
                            Reject
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
