import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { hashToken } from "../src/plugins/session-token.js";
import { issueTestSession, setupFixture, type TestFixture } from "./helpers/db.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const describeDb = DATABASE_URL ? describe : describe.skip;

const GOOGLE = "https://accounts.google.com";
const REDIRECT = "http://localhost:3000/auth/oidc/google/callback";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const tokenHash = () => `0x${randomBytes(32).toString("hex")}`;

/**
 * Interleavings of the account state machine — final cross-package review (migration 0132).
 *
 * Expected, from the contracts rather than the implementation:
 * - F1: an identity revoked by an MFA reset, an address change or an unlink signs nobody in, even
 *   when the sign-in started before the revocation committed and waited for it; a sign-in that
 *   committed first is ended by the revocation. Linking races a reset the same way. A Google /
 *   Microsoft session does not resolve once its identity is revoked.
 * - F3: a suspension and a reset decision, an email-change decision or an email-change completion
 *   of the same person never deadlock (40P01): both lock the person first, so one waits and then
 *   finds the other's result.
 *
 * Two application connections race; a third (the migration connection) holds or observes locks.
 * Each connection names itself (`application_name`) so the test waits for "blocked on a lock"
 * rather than for a fixed time, and other test files on the same database do not count.
 */
describeDb("account state races (0132)", { timeout: 60_000 }, () => {
  let fx: TestFixture;
  let one: postgres.Sql;
  let two: postgres.Sql;
  const names = { one: `race-one-${process.pid}`, two: `race-two-${process.pid}` };

  beforeAll(async () => {
    fx = await setupFixture();
    const connect = (name: string) => {
      const url = new URL(DATABASE_URL!);
      url.username = "mpc_app_login";
      url.password = "app";
      return postgres(url.toString(), { onnotice: () => {}, max: 1, connection: { application_name: name } });
    };
    one = connect(names.one);
    two = connect(names.two);
  });

  afterAll(async () => {
    await one?.end();
    await two?.end();
    await fx.close();
  });

  /** Resolves once `name`'s connection waits on a lock (or after 10 s, reporting false). */
  async function blockedOnLock(name: string): Promise<boolean> {
    for (let i = 0; i < 200; i++) {
      const [row] = await fx.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = ${name} AND wait_event_type = 'Lock'
      `;
      if (row!.n > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  const outcome = (work: Promise<unknown>) =>
    work.then(
      () => "ok",
      (error: { code?: string; message: string }) => `${error.code ?? ""} ${error.message}`,
    );

  /**
   * Runs `hold` on `holder` inside a transaction and keeps it open; then starts `racer`, waits
   * until it blocks on a lock, and commits the holder. Returns the racer's result.
   */
  async function race<T>(
    holder: postgres.Sql,
    hold: (tx: postgres.TransactionSql) => Promise<unknown>,
    racerName: string,
    racer: () => Promise<T>,
  ): Promise<{ result: T; blocked: boolean }> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const committed = holder.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant', ${fx.tenantA}, true)`;
      await hold(tx);
      held();
      await gate;
    });
    await holding;
    const racing = racer();
    const blocked = await blockedOnLock(racerName);
    release();
    await committed;
    return { result: await racing, blocked };
  }

  async function person(email: string | null = `p-${randomUUID().slice(0, 8)}@example.com`) {
    const id = randomUUID();
    await fx.sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name, email, created_at)
      VALUES (${id}, ${fx.tenantA}, 'person', 'Race person', ${email}, now() - interval '10 days')
    `;
    return id;
  }

  async function googleIdentity(subjectId: string) {
    const id = randomUUID();
    const key = `race-${randomUUID()}`;
    await fx.sql`
      INSERT INTO core.external_identities (id, tenant_id, subject_id, provider, issuer, subject_key, linked_via)
      VALUES (${id}, ${fx.tenantA}, ${subjectId}, 'google', ${GOOGLE}, ${key}, 'link')
    `;
    return { id, key };
  }

  /** A claimed Google transaction: `sign_in`, or `link` from `sessionId`. */
  async function claimed(purpose: "sign_in" | "link", sessionId: string | null = null) {
    const id = randomUUID();
    const state = randomUUID();
    const binding = randomUUID();
    await one.begin(async (tx) => {
      if (sessionId) await tx`SELECT set_config('app.current_tenant', ${fx.tenantA}, true)`;
      const [started] = await tx<{ status: string }[]>`
        SELECT status FROM core.start_oidc_transaction(
          ${id}, 'google', ${purpose}, ${sha(state)}, ${sha(binding)}, ${sha(randomUUID())}, ${randomBytes(48)},
          ${REDIRECT}, ${sessionId}, NULL, NULL, ${randomUUID()}
        )
      `;
      expect(started!.status).toBe("started");
      const [claim] = await tx<{ status: string }[]>`
        SELECT status FROM core.claim_oidc_transaction(${sha(state)}, ${sha(binding)}, 'google', ${sessionId})
      `;
      expect(claim!.status).toBe("claimed");
    });
    return id;
  }

  const signIn = (conn: postgres.Sql | postgres.TransactionSql, transactionId: string, key: string, sessionId: string) =>
    conn<{ status: string }[]>`
      SELECT status FROM core.complete_oidc_sign_in(${transactionId}, ${GOOGLE}, ${key}, ${sessionId}, ${tokenHash()}, 3600)
    `.then((rows) => rows[0]!.status);

  async function resetRequest(subjectId: string) {
    const id = randomUUID();
    await fx.sql`
      INSERT INTO core.mfa_reset_requests (id, tenant_id, subject_id, reason, requested_by_subject_id)
      VALUES (${id}, ${fx.tenantA}, ${subjectId}, 'lost', ${await person()})
    `;
    return id;
  }

  const approveReset = (tx: postgres.TransactionSql, resetId: string, decider: string) =>
    tx`SELECT * FROM core.decide_mfa_reset(${resetId}, ${decider}, true, 'approved', 1)`;

  async function approvedEmailChange(subjectId: string) {
    const change = randomUUID();
    const newEmail = `moved-${randomUUID().slice(0, 8)}@example.com`;
    await fx.sql`
      INSERT INTO core.email_change_requests (
        id, tenant_id, subject_id, new_email, reason, requested_by_subject_id,
        state, decided_by_subject_id, decided_at, decision_reason
      ) VALUES (
        ${change}, ${fx.tenantA}, ${subjectId}, ${newEmail}, 'r', ${await person()},
        'approved', ${await person()}, now(), 'ok'
      )
    `;
    const code = randomBytes(32);
    await fx.sql`
      INSERT INTO core.email_challenges (id, purpose, email, tenant_id, subject_id, email_change_id, code_hmac, created_at, expires_at)
      VALUES (${randomUUID()}, 'email_change', ${newEmail}, ${fx.tenantA}, ${subjectId}, ${change}, ${code},
              now() - interval '1 second', now() - interval '1 second' + interval '10 minutes')
    `;
    return { change, newEmail, code };
  }

  const completeEmailChange = (conn: postgres.Sql | postgres.TransactionSql, newEmail: string, code: Buffer) =>
    conn<{ status: string }[]>`
      SELECT status FROM core.complete_email_change(${newEmail}, ${code}, ${randomUUID()}, ${randomUUID()})
    `.then((rows) => rows[0]!.status);

  async function sessionIdOf(token: string) {
    const [row] = await fx.sql<{ id: string }[]>`SELECT id FROM core.sessions WHERE token_hash = ${hashToken(token)}`;
    return row!.id;
  }

  const sessionRow = async (id: string) =>
    (await fx.sql<{ revoked_at: Date | null }[]>`SELECT revoked_at FROM core.sessions WHERE id = ${id}`)[0];

  describe("F1: a revoked identity signs nobody in", () => {
    it("a sign-in waiting on an approved MFA reset finds the identity revoked", async () => {
      const subject = await person();
      const identity = await googleIdentity(subject);
      const reset = await resetRequest(subject);
      const transaction = await claimed("sign_in");
      const decider = await person();
      const sessionId = randomUUID();

      const { result, blocked } = await race(two, (tx) => approveReset(tx, reset, decider), names.one, () =>
        signIn(one, transaction, identity.key, sessionId),
      );
      expect(blocked).toBe(true);
      expect(result).toBe("not_found");
      expect(await sessionRow(sessionId)).toBeUndefined();
      const [revoked] = await fx.sql`SELECT revoked_reason FROM core.external_identities WHERE id = ${identity.id}`;
      expect(revoked!.revoked_reason).toBe("mfa_reset");
    });

    it("a sign-in that locked the identity first is ended by the reset that waited for it", async () => {
      const subject = await person();
      const identity = await googleIdentity(subject);
      const reset = await resetRequest(subject);
      const decider = await person();
      const transaction = await claimed("sign_in");
      const sessionId = randomUUID();

      const { result, blocked } = await race(
        one,
        async (tx) => expect(await signIn(tx, transaction, identity.key, sessionId)).toBe("session_created"),
        names.two,
        () => outcome(two.begin(async (tx) => {
          await tx`SELECT set_config('app.current_tenant', ${fx.tenantA}, true)`;
          await approveReset(tx, reset, decider);
        })),
      );
      expect(blocked).toBe(true);
      expect(result).toBe("ok");
      expect((await sessionRow(sessionId))!.revoked_at).toBeInstanceOf(Date);
    });

    it("a sign-in waiting on a completed address change finds the identity revoked", async () => {
      const subject = await person();
      const identity = await googleIdentity(subject);
      const { newEmail, code } = await approvedEmailChange(subject);
      const transaction = await claimed("sign_in");
      const sessionId = randomUUID();

      const { result, blocked } = await race(
        two,
        async (tx) => expect(await completeEmailChange(tx, newEmail, code)).toBe("completed"),
        names.one,
        () => signIn(one, transaction, identity.key, sessionId),
      );
      expect(blocked).toBe(true);
      expect(result).toBe("not_found");
      expect(await sessionRow(sessionId)).toBeUndefined();
    });

    it("a sign-in waiting on an unlink finds the identity revoked", async () => {
      const subject = await person();
      const identity = await googleIdentity(subject);
      const holder = await sessionIdOf(
        await issueTestSession(fx.appSql, fx.tenantA, subject, { firstFactor: "email_code", secondFactor: "totp" }),
      );
      const transaction = await claimed("sign_in");
      const sessionId = randomUUID();

      const { result, blocked } = await race(
        two,
        (tx) => tx`SELECT * FROM core.unlink_external_identity(${holder}, ${identity.id})`,
        names.one,
        () => signIn(one, transaction, identity.key, sessionId),
      );
      expect(blocked).toBe(true);
      expect(result).toBe("not_found");
      expect(await sessionRow(sessionId)).toBeUndefined();
    });

    it("a link waiting on an approved MFA reset finds its session ended and links nothing", async () => {
      const subject = await person();
      const holder = await sessionIdOf(
        await issueTestSession(fx.appSql, fx.tenantA, subject, { firstFactor: "email_code", secondFactor: "totp" }),
      );
      const reset = await resetRequest(subject);
      const decider = await person();
      const transaction = await claimed("link", holder);
      const key = `race-link-${randomUUID()}`;

      const { result, blocked } = await race(two, (tx) => approveReset(tx, reset, decider), names.one, () =>
        outcome(one.begin(async (tx) => {
          await tx`SELECT set_config('app.current_tenant', ${fx.tenantA}, true)`;
          await tx`
            SELECT * FROM core.complete_oidc_link(${transaction}, ${holder}, ${GOOGLE}, ${key}, NULL, NULL, ${randomUUID()})
          `;
        })),
      );
      expect(blocked).toBe(true);
      expect(result).toMatch(/MFA_SESSION_INVALID/);
      expect(await fx.sql`SELECT 1 FROM core.external_identities WHERE subject_key = ${key}`).toHaveLength(0);
    });

    it("a link that committed first is revoked by the reset that waited for it", async () => {
      const subject = await person();
      const holder = await sessionIdOf(
        await issueTestSession(fx.appSql, fx.tenantA, subject, { firstFactor: "email_code", secondFactor: "totp" }),
      );
      const reset = await resetRequest(subject);
      const decider = await person();
      const transaction = await claimed("link", holder);
      const key = `race-link-${randomUUID()}`;

      const { result, blocked } = await race(
        one,
        async (tx) => {
          const [linked] = await tx<{ status: string }[]>`
            SELECT status FROM core.complete_oidc_link(${transaction}, ${holder}, ${GOOGLE}, ${key}, NULL, NULL, ${randomUUID()})
          `;
          expect(linked!.status).toBe("linked");
        },
        names.two,
        () => outcome(two.begin(async (tx) => {
          await tx`SELECT set_config('app.current_tenant', ${fx.tenantA}, true)`;
          await approveReset(tx, reset, decider);
        })),
      );
      expect(blocked).toBe(true);
      expect(result).toBe("ok");
      const [identity] = await fx.sql`SELECT revoked_reason FROM core.external_identities WHERE subject_key = ${key}`;
      expect(identity!.revoked_reason).toBe("mfa_reset");
    });

    it("a Google session does not resolve once its identity is revoked, however that happened", async () => {
      const subject = await person();
      const token = await issueTestSession(fx.appSql, fx.tenantA, subject, { firstFactor: "google" });
      const resolve = () => fx.appSql`SELECT session_id FROM core.resolve_session(${hashToken(token)})`;
      expect(await resolve()).toHaveLength(1);
      // Revoked straight at the table: no function ended the session; the resolver still refuses it.
      await fx.sql`
        UPDATE core.external_identities SET revoked_at = now(), revoked_reason = 'mfa_reset'
        WHERE subject_id = ${subject} AND revoked_at IS NULL
      `;
      expect((await sessionRow(await sessionIdOf(token)))!.revoked_at).toBeNull();
      expect(await resolve()).toHaveLength(0);
    });
  });

  describe("F3: one lock order — the person, then their requests", () => {
    /**
     * Holds the person's subject row on the migration connection, queues the suspension decision
     * behind it, then the other decision, and releases. With the request locked before the
     * subject (before 0132) the second one held its request while it waited for the subject,
     * which the suspension then needed: 40P01.
     */
    async function queuedBehindSubject(subject: string, suspend: () => Promise<string>, other: () => Promise<string>) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const lockedP = new Promise<void>((resolve) => (locked = resolve));
      const holding = fx.sql.begin(async (tx) => {
        await tx`SELECT 1 FROM core.subjects WHERE id = ${subject} FOR UPDATE`;
        locked();
        await gate;
      });
      await lockedP;
      const first = suspend();
      expect(await blockedOnLock(names.two)).toBe(true);
      const second = other();
      expect(await blockedOnLock(names.one)).toBe(true);
      release();
      await holding;
      return { suspension: await first, other: await second };
    }

    async function suspensionRequest(subject: string) {
      const id = randomUUID();
      await fx.sql`
        INSERT INTO core.subject_suspensions (id, tenant_id, subject_id, action, reason, requested_by_subject_id)
        VALUES (${id}, ${fx.tenantA}, ${subject}, 'suspend', 'r', ${await person()})
      `;
      const decider = await person();
      return () => outcome(two.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant', ${fx.tenantA}, true)`;
        await tx`SELECT * FROM core.decide_subject_suspension(${id}, ${decider}, true, 'ok', 1)`;
      }));
    }

    it("a suspension and an MFA reset decision of the same person", async () => {
      const subject = await person();
      const reset = await resetRequest(subject);
      const decider = await person();
      const suspend = await suspensionRequest(subject);
      const outcomes = await queuedBehindSubject(subject, suspend, () =>
        outcome(one.begin(async (tx) => {
          await tx`SELECT set_config('app.current_tenant', ${fx.tenantA}, true)`;
          await approveReset(tx, reset, decider);
        })),
      );
      expect(outcomes.suspension).toBe("ok");
      // The reset waited, then found it closed by the suspension (a new version): no deadlock.
      expect(outcomes.other).toMatch(/^40001 MFA_RESET_VERSION_MISMATCH/);
      const [closed] = await fx.sql`SELECT state::text, closed_reason FROM core.mfa_reset_requests WHERE id = ${reset}`;
      expect(closed).toEqual({ state: "rejected", closed_reason: "subject_suspended" });
    });

    it("a suspension and an email-change decision of the same person", async () => {
      const subject = await person();
      const change = randomUUID();
      await fx.sql`
        INSERT INTO core.email_change_requests (id, tenant_id, subject_id, new_email, reason, requested_by_subject_id)
        VALUES (${change}, ${fx.tenantA}, ${subject}, ${`moved-${change.slice(0, 8)}@example.com`}, 'r', ${await person()})
      `;
      const decider = await person();
      const suspend = await suspensionRequest(subject);
      let status = "";
      const outcomes = await queuedBehindSubject(subject, suspend, () =>
        outcome(one.begin(async (tx) => {
          await tx`SELECT set_config('app.current_tenant', ${fx.tenantA}, true)`;
          const [decided] = await tx<{ status: string }[]>`
            SELECT status FROM core.decide_email_change(
              ${change}, ${decider}, true, 'ok', 1, ${randomUUID()}, ${randomBytes(32)}, '12345678'
            )
          `;
          status = decided!.status;
        })),
      );
      expect(outcomes).toEqual({ suspension: "ok", other: "ok" });
      expect(status).toBe("version_mismatch");
      const [closed] = await fx.sql`SELECT state, closed_reason FROM core.email_change_requests WHERE id = ${change}`;
      expect(closed).toEqual({ state: "expired", closed_reason: "subject_suspended" });
    });

    it("a suspension and an email-change completion of the same person", async () => {
      const subject = await person();
      const { newEmail, code } = await approvedEmailChange(subject);
      const suspend = await suspensionRequest(subject);
      let status = "";
      const outcomes = await queuedBehindSubject(subject, suspend, () =>
        outcome(completeEmailChange(one, newEmail, code).then((s) => (status = s))),
      );
      expect(outcomes).toEqual({ suspension: "ok", other: "ok" });
      expect(status).toBe("code_invalid");
      const [after] = await fx.sql<{ email: string }[]>`SELECT email FROM core.subjects WHERE id = ${subject}`;
      expect(after!.email).not.toBe(newEmail);
    });
  });

  describe("0133: the approver's suspension and the person's sign-in race cleanly", () => {
    /** A pending suspension of `subject`, decided on `conn` inside `tx`. */
    async function suspensionOf(subject: string) {
      const id = randomUUID();
      await fx.sql`
        INSERT INTO core.subject_suspensions (id, tenant_id, subject_id, action, reason, requested_by_subject_id)
        VALUES (${id}, ${fx.tenantA}, ${subject}, 'suspend', 'r', ${await person()})
      `;
      const decider = await person();
      return (tx: postgres.TransactionSql) =>
        tx`SELECT * FROM core.decide_subject_suspension(${id}, ${decider}, true, 'ok', 1)`;
    }

    const resetRow = async (id: string) =>
      (await fx.sql<{ state: string; closed_reason: string | null }[]>`
        SELECT state::text, closed_reason FROM core.mfa_reset_requests WHERE id = ${id}
      `)[0];

    it("L2: an approval waiting on its approver's suspension is refused, not left open", async () => {
      const approver = await person();
      const target = await person();
      const reset = await resetRequest(target);
      const suspend = await suspensionOf(approver);

      // The suspension has closed what the approver approved so far; the approval is still to come.
      const { result, blocked } = await race(two, suspend, names.one, () =>
        outcome(one.begin(async (tx) => {
          await tx`SELECT set_config('app.current_tenant', ${fx.tenantA}, true)`;
          await approveReset(tx, reset, approver);
        })),
      );
      expect(blocked).toBe(true);
      // Before 0133 the approval read "not suspended", waited on its foreign key and committed.
      expect(result).toMatch(/^42501 ACTOR_SUSPENDED/);
      expect(await resetRow(reset)).toEqual({ state: "pending", closed_reason: null });
      expect((await fx.sql`SELECT core.mfa_reset_window_open(${target}) AS open`)[0]!.open).toBe(false);
    });

    it("L2: an approval that committed first is closed by the suspension that waited for it", async () => {
      const approver = await person();
      const target = await person();
      const reset = await resetRequest(target);
      const suspend = await suspensionOf(approver);

      const { result, blocked } = await race(one, (tx) => approveReset(tx, reset, approver), names.two, () =>
        outcome(two.begin(async (tx) => {
          await tx`SELECT set_config('app.current_tenant', ${fx.tenantA}, true)`;
          await suspend(tx);
        })),
      );
      expect(blocked).toBe(true);
      expect(result).toBe("ok");
      expect(await resetRow(reset)).toEqual({ state: "approved", closed_reason: "approver_suspended" });
      expect((await fx.sql`SELECT core.mfa_reset_window_open(${target}) AS open`)[0]!.open).toBe(false);
    });

    it("N1: a sign-in started while a reset holds the person waits before the identity, so neither deadlocks", async () => {
      const subject = await person();
      const identity = await googleIdentity(subject);
      const reset = await resetRequest(subject);
      const decider = await person();
      const transaction = await claimed("sign_in");
      const sessionId = randomUUID();

      // The reset has locked the person (its first step) and pauses before it revokes anything.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const lockedP = new Promise<void>((resolve) => (locked = resolve));
      const resetting = outcome(two.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant', ${fx.tenantA}, true)`;
        await tx`SELECT 1 FROM core.subjects WHERE id = ${subject} FOR UPDATE`;
        locked();
        await gate;
        // Revokes the identity. Before 0133 the sign-in held it and waited on the person: 40P01.
        await approveReset(tx, reset, decider);
      }));
      await lockedP;
      const signing = signIn(one, transaction, identity.key, sessionId).catch(
        (error: { code?: string; message: string }) => `${error.code ?? ""} ${error.message}`,
      );
      expect(await blockedOnLock(names.one)).toBe(true);
      // The sign-in waits on the person, not holding the identity.
      const free = await fx.sql.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '200ms'`;
        return tx`SELECT 1 FROM core.external_identities WHERE id = ${identity.id} FOR UPDATE`.then(
          () => true,
          () => false,
        );
      });
      expect(free).toBe(true);
      release();
      expect(await resetting).toBe("ok");
      expect(await signing).toBe("not_found");
      expect(await sessionRow(sessionId)).toBeUndefined();
      const [revoked] = await fx.sql`SELECT revoked_reason FROM core.external_identities WHERE id = ${identity.id}`;
      expect(revoked!.revoked_reason).toBe("mfa_reset");
    });
  });
});
