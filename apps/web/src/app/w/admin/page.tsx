"use client";

import { useCallback, useEffect, useState } from "react";
import {
  bindAdminWallet,
  createNotificationSink,
  listNotificationSinks,
  updateNotificationSinkState,
  type NotificationSink,
  createAdminSubject,
  createRoleGrant,
  decideRoleGrant,
  disableAdminWallet,
  listAdminSubjects,
  listRoleGrants,
  newIdempotencyKey,
  type AdminSubject,
  type RoleGrant,
} from "@/lib/api";
import { useSession } from "@/lib/session";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Address } from "@/components/Address";

/**
 * Administration — spec 11 §11.2.
 *
 * 이 화면이 있기 전에는 배포된 시스템에 사람을 추가하는 유일한 방법이 서버에서
 * `bootstrap` CLI를 돌리는 것이었다. 그 CLI는 RLS를 우회하는 superuser 연결로
 * 돈다.
 *
 * **혼자 권한을 줄 수 없다는 것이 이 화면의 형태를 정한다.** 역할 부여는
 * "제안"과 "결정"으로 갈리고, 제안한 사람에게는 결정 버튼이 나타나지 않는다.
 * 서버도 같은 것을 막는다 — 버튼을 숨기는 것은 보안 통제가 아니다(02 §2.1).
 *
 * **잠긴 계정을 먼저 보인다.** 붙은 지갑이 전부 비활성이면 역할이 무엇이든
 * 로그인할 수 없다. 그 상태를 목록 안에 섞어 두면 눈에 띄지 않는다.
 */

const REASON_CODES = [
  { value: "key_lost", label: "Key lost" },
  { value: "key_compromised", label: "Key compromised" },
  { value: "rotation", label: "Planned rotation" },
  { value: "offboarding", label: "Offboarding" },
] as const;

/** 역할 부여를 승인할 수 있는 역할. 서버의 `admin.role.approve`와 같은 목록이다. */
const ADMIN_ROLES: readonly string[] = ["mpc_operator", "security_operator"];

export default function AdminPage() {
  const { token, session, loading: sessionLoading } = useSession();
  const [subjects, setSubjects] = useState<AdminSubject[]>([]);
  const [grants, setGrants] = useState<RoleGrant[]>([]);
  const [sinks, setSinks] = useState<NotificationSink[]>([]);
  const [sinkUrl, setSinkUrl] = useState("");
  const [sinkSecret, setSinkSecret] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(true);

  const [newName, setNewName] = useState("");
  const [walletFor, setWalletFor] = useState<string | null>(null);
  const [walletAddress, setWalletAddress] = useState("");
  const [disableFor, setDisableFor] = useState<{ id: string; version: number } | null>(null);
  const [reasonCode, setReasonCode] = useState<string>("key_lost");
  const [detail, setDetail] = useState("");
  const [grantFor, setGrantFor] = useState<string | null>(null);
  const [grantRole, setGrantRole] = useState("");
  const [grantReason, setGrantReason] = useState("");

  const reload = useCallback(async () => {
    if (!token) return;
    setBusy(true);
    try {
      const [subjectPage, grantPage, sinkPage] = await Promise.all([
        listAdminSubjects(token),
        listRoleGrants(token),
        listNotificationSinks(token),
      ]);
      setSubjects(subjectPage.items);
      setGrants(grantPage.items);
      setSinks(sinkPage.items);
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

  if (!sessionLoading && !session?.authenticated) {
    return <p className="sub">No account is connected.</p>;
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Administration</h1>
          <p className="sub">
            People, wallets, and roles for this tenant. Granting a role takes two people: one
            proposes, another decides. The server enforces that — hiding a button is not a control.
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
                        {wallet.disabledAt ? (
                          <span style={{ color: "var(--destructive-text)" }}>disabled</span>
                        ) : wallet.walletAddress === session?.walletAddress?.toLowerCase() ? (
                          // 자기 지갑은 끌 수 없다. 버튼을 두면 누른 뒤에야 거절을 본다.
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
                    {subject.roles.length === 0
                      ? "none"
                      : subject.roles.map((role) => role.role).join(", ")}
                  </td>
                  <td>
                    {/* 운영 권한자에게는 화면에서 지갑을 붙이지 않는다. 키 교체는 bootstrap이다. */}
                    {subject.roles.some((role) => ADMIN_ROLES.includes(role.role)) ? (
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
          <form
            className="row"
            style={{ alignItems: "flex-end" }}
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                // 서버 세션의 체인을 쓴다. 숫자를 박아 두면 stg·prod(56)에서 어긋난다.
                if (!session?.chainId) throw new Error("No session chain. Connect again.");
                await bindAdminWallet(token!, newIdempotencyKey(), walletFor, {
                  walletAddress: walletAddress.trim().toLowerCase(),
                  chainId: session.chainId,
                  assuranceLevel: "identity_bound",
                });
                setWalletFor(null);
                setWalletAddress("");
              });
            }}
          >
            <div className="field" style={{ marginBottom: 0, flex: 1, minWidth: 260 }}>
              <label htmlFor="wallet-address">Wallet address</label>
              <input
                id="wallet-address"
                className="mono"
                value={walletAddress}
                onChange={(event) => setWalletAddress(event.target.value)}
                placeholder="0x…"
              />
            </div>
            <button className="primary" type="submit">
              Bind
            </button>
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

      {/*
        알림 수신처.

        **등록돼 있다와 실제로 가고 있다를 구분해 보인다.** 설정해 두고 아무것도
        못 보내는 상태가 가장 나쁘다 — 보내고 있다고 믿는다.
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
              placeholder="file:/run/secrets/notify_hmac"
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
          {/* 값을 붙여넣게 하면 그것이 DB에 남는다. 참조만 받는다(05 §5.12). */}
          A reference, not the secret itself. The worker resolves `file:` and `env:` references at
          send time; the value never enters this database.
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
                        <div className="meta">{sink.delivery.lastError}</div>
                      ) : null}
                    </td>
                    <td>
                      {/* 지우지 않고 멈춘다. 지우면 왜 끊겼는지가 남지 않는다. */}
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
                          제안자에게는 결정 버튼을 주지 않는다. 서버도 같은 것을
                          막지만, 누를 수 있는 버튼이 항상 거절되면 화면이
                          고장난 것처럼 보인다.
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
    </>
  );
}
