import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type postgres from "postgres";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
  createMfaResetRequest,
  decideMfaResetRequest,
  passkeyAuthenticationRequest,
  passkeyRegistrationRequest,
  recoveryCodeRequest,
  renamePasskeyRequest,
  totpCodeRequest,
  WEBAUTHN_TRANSPORTS,
  type AuthenticationLevel,
  type SecondFactor,
} from "@mpc/api-contract";
import { withTenant } from "@mpc/db";
import type { AppConfig } from "../config.js";
import { ROLE_SELF_BOUND, recordAudit } from "../audit.js";
import { hashUserAgent } from "../device.js";
import {
  AppError,
  badRequest,
  conflict,
  forbidden,
  notFound,
  preconditionFailed,
  tooManyRequests,
  unauthorized,
  unprocessable,
} from "../errors.js";
import { assertAuthorized, sessionFacts, tenantResource } from "../plugins/authorize.js";
import { hashRequest, withIdempotency } from "../plugins/idempotency.js";
import { recoverySeparationRequired, subjectSuspended } from "./account-shared.js";
import type { Session } from "../plugins/session.js";
import {
  decryptTotpSecret,
  deriveTotpKey,
  encryptTotpSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  matchTotpStep,
  newTotpSecret,
  normalizeRecoveryCode,
  totpProvisioning,
} from "../services/mfa.js";
import {
  assertVersionMatches,
  etagOf,
  requireIfMatch,
  requireMutationContext,
  requireReadContext,
} from "./shared.js";

/**
 * Second factors — account authentication WP3.
 *
 * **Who decides what.** The cryptography is checked here (`@simplewebauthn/server`, `otpauth`);
 * everything else — whether this session may enrol now, single use of challenges and TOTP steps,
 * the lockout, the counter, which sessions end — is decided by the database functions of 0116 /
 * 0117, inside the caller's tenant, with the session and subject rows locked. A route never
 * states a factor; it hands the database the evidence it just verified, and the database records
 * the factor only by consuming that evidence.
 *
 * **Who may call.** Each route acts on the caller's own session (`self_bound` in the audit
 * trail). The request hook lets a first-factor-only session reach only the routes the contract
 * marks `allowsFirstFactorOnly`, and a recovery-limited one only `allowsRecoveryLimited`. Service
 * tokens never reach these routes (no service scope).
 *
 * **Failures are recorded** in their own transaction before the refusal is returned, so a burst
 * of failed attempts leaves a trail even though the request itself fails.
 */

const RP_NAME = "MPC Registry";
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

type Tx = postgres.TransactionSql;

interface AccountContext {
  readonly session: Session & { readonly tenantId: string; readonly subjectId: string };
  readonly tenantId: string;
  readonly subjectId: string;
}

/** A person's account session in a tenant. Service sessions do not do MFA. */
function requireAccountSession(request: FastifyRequest): AccountContext {
  const session = request.session;
  if (!session) throw unauthorized("UNAUTHENTICATED", "Authentication required");
  if (session.principal !== "person" || session.tenantId === null || session.subjectId === null) {
    throw forbidden("MFA_ACCOUNT_SESSION_REQUIRED", "Only an account session has second factors");
  }
  return {
    session: { ...session, tenantId: session.tenantId, subjectId: session.subjectId },
    tenantId: session.tenantId,
    subjectId: session.subjectId,
  };
}

/**
 * The database's refusal codes (`MFA_*: …` messages raised by 0116 / 0117) → the API error a
 * client sees. Anything else is not a refusal and propagates as a server error.
 */
const DB_REFUSALS: Readonly<Record<string, (message: string) => AppError>> = {
  MFA_SESSION_INVALID: () => unauthorized("UNAUTHENTICATED", "The session is no longer valid"),
  MFA_STEP_UP_REQUIRED: () =>
    forbidden("MFA_STEP_UP_REQUIRED", "Prove an existing second factor first", {
      reason: "AUTHENTICATION_LEVEL_INSUFFICIENT",
      requiredAal: "aal2",
    }),
  MFA_PASSKEY_REQUIRED: () =>
    forbidden("MFA_PASSKEY_REQUIRED", "Sign in with an existing passkey first", {
      reason: "AUTHENTICATION_LEVEL_INSUFFICIENT",
      requiredAal: "aal3",
    }),
  MFA_ENROLMENT_WINDOW_CLOSED: () =>
    forbidden(
      "MFA_ENROLMENT_WINDOW_CLOSED",
      "A first factor can be enrolled only within 24 hours of the invitation or of an admin reset",
      { hint: "Ask an administrator for an MFA reset" },
    ),
  MFA_TOTP_ALREADY_ENROLLED: () =>
    conflict("MFA_TOTP_ALREADY_ENROLLED", "An authenticator app is already enrolled; remove it first"),
  MFA_NO_PASSKEY: () => conflict("MFA_NO_PASSKEY", "This account has no passkey"),
  MFA_CHALLENGE_INVALID: () =>
    unauthorized("MFA_CHALLENGE_INVALID", "No live challenge of this session matches; start again"),
  MFA_USER_VERIFICATION_REQUIRED: () =>
    unauthorized("MFA_USER_VERIFICATION_REQUIRED", "The authenticator must verify you (PIN or biometric)"),
  MFA_CREDENTIAL_EXISTS: () => conflict("MFA_CREDENTIAL_EXISTS", "This passkey is already registered"),
  MFA_CREDENTIAL_UNKNOWN: () => unauthorized("MFA_PASSKEY_INVALID", "The passkey could not be verified"),
  MFA_COUNTER_REGRESSION: () => unauthorized("MFA_PASSKEY_INVALID", "The passkey could not be verified"),
  MFA_TOTP_NOT_ENROLLED: () => conflict("MFA_TOTP_NOT_ENROLLED", "No authenticator app setup to check this code against"),
  MFA_TOTP_LOCKED: (message) =>
    tooManyRequests("MFA_TOTP_LOCKED", "Too many attempts. Try again later", {
      retryAfter: /after (\S+)$/.exec(message)?.[1] ?? null,
    }),
  MFA_TOTP_REPLAYED: () => unauthorized("MFA_TOTP_INVALID", "The code is not valid"),
  MFA_ALREADY_SATISFIED: () => conflict("MFA_ALREADY_SATISFIED", "This session already proved a second factor"),
  MFA_RECOVERY_CODE_INVALID: () => unauthorized("MFA_RECOVERY_CODE_INVALID", "The recovery code is not valid"),
  MFA_RECOVERY_REENROLMENT_REQUIRED: () =>
    forbidden("MFA_RECOVERY_REENROLMENT_REQUIRED", "Enrol a new passkey or authenticator app first"),
  MFA_AUTHENTICATOR_UNKNOWN: () => notFound("No such active authenticator on this account"),
  MFA_LAST_FACTOR: () =>
    unprocessable("MFA_LAST_FACTOR", "The last passkey or authenticator app cannot be removed", {
      hint: "Enrol another factor first, or ask an administrator for an MFA reset",
    }),
  MFA_RESET_NOT_FOUND: () => notFound("MFA reset request not found"),
  MFA_RESET_VERSION_MISMATCH: () =>
    preconditionFailed("RESOURCE_VERSION_MISMATCH", "This resource changed after it was read. Reread and decide again."),
  MFA_RESET_ALREADY_DECIDED: () => unprocessable("MFA_RESET_ALREADY_DECIDED", "The request is already decided"),
  // 0118: whoever proposed or decided a recent email change of the person takes no part in
  // resetting their factors (and the reverse), or two admins could take the account over.
  MFA_RESET_SEPARATION_REQUIRED: () => recoverySeparationRequired(),
  // 0128: no reset of a suspended person; reinstating them opens an enrolment window instead.
  MFA_RESET_SUBJECT_SUSPENDED: () => subjectSuspended(),
  // The decision route refuses the proposer and the subject before calling the database, which
  // refuses them again; those two refusals are therefore not mapped here.
};

/** The refusal code a database error carries, or null for any other error. */
function refusalCode(caught: unknown): string | null {
  if (!(caught instanceof Error)) return null;
  const code = /^(MFA_[A-Z_]+):/.exec(caught.message)?.[1];
  return code !== undefined && code in DB_REFUSALS ? code : null;
}

function translate(caught: unknown): unknown {
  const code = refusalCode(caught);
  return code === null ? caught : DB_REFUSALS[code]!((caught as Error).message);
}

/** Runs database work in the caller's tenant and turns MFA refusals into API errors. */
async function inTenant<T>(sql: postgres.Sql, tenantId: string, work: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await withTenant(sql, { tenantId }, work);
  } catch (caught) {
    throw translate(caught);
  }
}

function invalidRequest(issues: unknown): AppError {
  return badRequest("REQUEST_INVALID", "Request format is invalid", { issues });
}

function aalOf(factor: SecondFactor | null): AuthenticationLevel {
  if (factor === "passkey") return "aal3";
  return factor === null ? "aal1" : "aal2";
}

function newChallenge(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(randomBytes(32));
}

/** Transports the browser reported, minus any this registry does not know (the column refuses them). */
function knownTransports(values: readonly string[] | undefined): (typeof WEBAUTHN_TRANSPORTS)[number][] {
  const allowed: readonly string[] = WEBAUTHN_TRANSPORTS;
  return [...new Set((values ?? []).filter((value) => allowed.includes(value)))] as (typeof WEBAUTHN_TRANSPORTS)[number][];
}

/** The single row a set-returning MFA function returns. */
function only<T>(rows: readonly T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error("expected one row");
  return row;
}

/** The 16 bytes of a UUID: the WebAuthn user handle. Stable per subject, says nothing about them. */
function uuidBytes(id: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(id.replace(/-/g, ""), "hex"));
}

interface PasskeyRow {
  id: string;
  credential_id: string;
  public_key: Buffer;
  sign_count: string;
  transports: string[];
  name: string;
  created_at: Date;
  last_used_at: Date | null;
  device_type: "singleDevice" | "multiDevice";
  backed_up: boolean;
}

function toPasskey(row: PasskeyRow) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    transports: knownTransports(row.transports),
    deviceType: row.device_type,
    backedUp: row.backed_up,
  };
}

function activePasskeys(tx: Tx, subjectId: string) {
  return tx<PasskeyRow[]>`
    SELECT id, credential_id, public_key, sign_count::text, transports, name, created_at,
           last_used_at, device_type, backed_up
    FROM core.webauthn_credentials
    WHERE subject_id = ${subjectId} AND revoked_at IS NULL
    ORDER BY created_at
  `;
}

interface MfaResetRow {
  id: string;
  subject_id: string;
  subject_name: string;
  reason: string;
  requested_by_subject_id: string;
  requested_at: Date;
  state: "pending" | "approved" | "rejected";
  decided_by_subject_id: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
  enrolment_window_until: Date | null;
  closed_reason: "subject_suspended" | "proposer_suspended" | "approver_suspended" | null;
  version: number;
}

function readResets(tx: Tx, resetId?: string) {
  return tx<MfaResetRow[]>`
    SELECT r.id, r.subject_id, s.display_name AS subject_name, r.reason, r.requested_by_subject_id,
           r.requested_at, r.state, r.decided_by_subject_id, r.decided_at, r.decision_reason,
           r.enrolment_window_until, r.closed_reason, r.version
    FROM core.mfa_reset_requests r
    JOIN core.subjects s ON s.id = r.subject_id
    -- A bootstrap window (0118) is the deploy runner's, not an admin request: not listed, not decided.
    WHERE r.origin = 'admin'
      AND (${resetId ?? null}::uuid IS NULL OR r.id = ${resetId ?? null})
    ORDER BY r.requested_at DESC
  `;
}

function toReset(row: MfaResetRow, requestId: string, asOf: string) {
  return {
    id: row.id,
    subjectId: row.subject_id,
    subjectName: row.subject_name,
    reason: row.reason,
    requestedBySubjectId: row.requested_by_subject_id,
    requestedAt: row.requested_at.toISOString(),
    state: row.state,
    decidedBySubjectId: row.decided_by_subject_id,
    decidedAt: row.decided_at?.toISOString() ?? null,
    decisionReason: row.decision_reason,
    enrolmentWindowUntil: row.enrolment_window_until?.toISOString() ?? null,
    closedReason: row.closed_reason,
    version: row.version,
    requestId,
    asOf,
  };
}

export async function registerMfaRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
  config: AppConfig,
): Promise<void> {
  const totpKey = deriveTotpKey(config.sessionSecret);

  // TOTP secrets and recovery codes travel in these responses; no cache may keep any of them.
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/api/v1/auth/mfa")) reply.header("cache-control", "no-store");
    return payload;
  });
  // Code checks are guessable; they get the login cap, per address, on top of the per-account
  // lockout the database keeps.
  const verifyLimit = { config: { rateLimit: { max: config.authRateLimitMax, timeWindow: "1 minute" } } };

  /**
   * Pass the mutation transaction for success events, so audit failure cannot leave a completed
   * change reported as failed. Refusal events commit separately. Never carries secrets.
   */
  async function audit(
    request: FastifyRequest,
    ctx: AccountContext,
    command: string,
    detail: Record<string, unknown> = {},
    resourceId: string = ctx.session.sessionId,
    tx?: Tx,
  ): Promise<void> {
    const write = (auditTx: Tx) =>
      recordAudit(auditTx, {
        tenantId: ctx.tenantId,
        session: { ...ctx.session, device: { userAgentHash: hashUserAgent(request.headers["user-agent"]) } },
        effectiveRole: ROLE_SELF_BOUND,
        command,
        resourceType: "authenticator",
        resourceId,
        correlationId: request.context.correlationId,
        requestIp: request.clientIp,
        detail: { subjectId: ctx.subjectId, ...detail },
      });
    if (tx) await write(tx);
    else await withTenant(sql, { tenantId: ctx.tenantId }, write);
  }

  /** Records the failure (committed on its own), then refuses. */
  async function refuse(
    request: FastifyRequest,
    ctx: AccountContext,
    command: string,
    error: unknown,
    detail: Record<string, unknown> = {},
  ): Promise<never> {
    const translated = translate(error);
    const code = translated instanceof AppError ? translated.code : "INTERNAL";
    await audit(request, ctx, command, { ...detail, outcome: code });
    throw translated;
  }

  // --- Status ----------------------------------------------------------------------------------

  app.get("/api/v1/auth/mfa", async (request) => {
    const ctx = requireAccountSession(request);
    return inTenant(sql, ctx.tenantId, async (tx) => {
      const [status] = await tx<
        {
          passkey_enrolled: boolean;
          totp_enrolled: boolean;
          recovery_codes_remaining: number;
          recovery_limited: boolean;
          passkey_enrolment: string;
          totp_enrolment: string;
        }[]
      >`SELECT * FROM core.mfa_status(${ctx.session.sessionId})`;
      // A first-factor or recovery-limited session learns whether a factor exists, not its names.
      const full = ctx.session.aal !== "aal1" && !ctx.session.recoveryLimited;
      return {
        passkeyEnrolled: status!.passkey_enrolled,
        totpEnrolled: status!.totp_enrolled,
        recoveryCodesRemaining: full ? status!.recovery_codes_remaining : null,
        recoveryLimited: status!.recovery_limited,
        enrolment: { passkey: status!.passkey_enrolment, totp: status!.totp_enrolment },
        passkeys: full ? (await activePasskeys(tx, ctx.subjectId)).map(toPasskey) : [],
        requestId: request.context.requestId,
      };
    });
  });

  // --- Passkey registration --------------------------------------------------------------------

  app.post("/api/v1/auth/mfa/passkeys/registration/options", async (request) => {
    const ctx = requireAccountSession(request);
    return inTenant(sql, ctx.tenantId, async (tx) => {
      const [subject] = await tx<{ display_name: string }[]>`
        SELECT display_name FROM core.subjects WHERE id = ${ctx.subjectId}
      `;
      const existing = await activePasskeys(tx, ctx.subjectId);
      const options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: config.webauthn.rpId,
        userID: uuidBytes(ctx.subjectId),
        userName: subject?.display_name ?? ctx.subjectId,
        userDisplayName: subject?.display_name ?? "",
        challenge: newChallenge(),
        timeout: CHALLENGE_TTL_MS,
        // No attestation: which authenticator model someone uses is not something this registry
        // decides on, and asking for it is a privacy cost for nothing.
        attestationType: "none",
        excludeCredentials: existing.map((row) => ({
          id: row.credential_id,
          transports: knownTransports(row.transports),
        })),
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      });
      const [issued] = await tx<{ expires_at: Date }[]>`
        SELECT core.create_webauthn_challenge(
          ${ctx.session.sessionId}, 'registration', ${options.challenge}
        ) AS expires_at
      `;
      return {
        options,
        expiresAt: issued!.expires_at.toISOString(),
        requestId: request.context.requestId,
      };
    });
  });

  app.post("/api/v1/auth/mfa/passkeys/registration/verify", verifyLimit, async (request) => {
    const ctx = requireAccountSession(request);
    const parsed = passkeyRegistrationRequest.safeParse(request.body);
    if (!parsed.success) throw invalidRequest(parsed.error.issues);

    const expected = await inTenant(sql, ctx.tenantId, async (tx) => {
      const [row] = await tx<{ challenge: string | null }[]>`
        SELECT core.live_webauthn_challenge(${ctx.session.sessionId}, 'registration') AS challenge
      `;
      return row?.challenge ?? null;
    });
    if (expected === null) {
      return refuse(request, ctx, "auth.mfa.passkey.enrol_failed", new Error("MFA_CHALLENGE_INVALID: none"));
    }

    let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verified = await verifyRegistrationResponse({
        response: parsed.data.response as unknown as RegistrationResponseJSON,
        expectedChallenge: expected,
        expectedOrigin: config.webauthn.origin,
        expectedRPID: config.webauthn.rpId,
        requireUserVerification: true,
      });
    } catch {
      verified = { verified: false };
    }
    if (!verified.verified) {
      return refuse(
        request,
        ctx,
        "auth.mfa.passkey.enrol_failed",
        unauthorized("MFA_PASSKEY_INVALID", "The passkey could not be verified"),
      );
    }

    const info = verified.registrationInfo;
    const codes = generateRecoveryCodes();
    let result: { passkey_id: string; recovery_codes_stored: boolean; session_ended: boolean };
    try {
      result = await withTenant(sql, { tenantId: ctx.tenantId }, async (tx) => {
        const registered = only(await tx<typeof result[]>`
          SELECT * FROM core.complete_webauthn_registration(
            ${ctx.session.sessionId}, ${expected}, ${info.credential.id},
            ${Buffer.from(info.credential.publicKey)}, ${info.credential.counter},
            ${knownTransports(parsed.data.response.response.transports ?? info.credential.transports)}::text[],
            ${info.aaguid}::uuid, ${info.userVerified}, ${info.credentialDeviceType},
            ${info.credentialBackedUp}, ${parsed.data.name ?? "Passkey"},
            ${codes.map(hashRecoveryCode)}::text[]
          )
        `);
        await audit(request, ctx, "auth.mfa.passkey.enrolled", {
          aaguid: info.aaguid,
          deviceType: info.credentialDeviceType,
          recoveryCodesGenerated: registered.recovery_codes_stored,
          recoveryCompleted: registered.session_ended,
        }, registered.passkey_id, tx);
        return registered;
      });
    } catch (caught) {
      return refuse(request, ctx, "auth.mfa.passkey.enrol_failed", caught);
    }

    return {
      aal: "aal3",
      secondFactor: "passkey",
      recoveryCodes: result.recovery_codes_stored ? codes : null,
      sessionEnded: result.session_ended,
      requestId: request.context.requestId,
    };
  });

  // --- Passkey step-up -------------------------------------------------------------------------

  app.post("/api/v1/auth/mfa/passkeys/authentication/options", async (request) => {
    const ctx = requireAccountSession(request);
    return inTenant(sql, ctx.tenantId, async (tx) => {
      const existing = await activePasskeys(tx, ctx.subjectId);
      const options = await generateAuthenticationOptions({
        rpID: config.webauthn.rpId,
        challenge: newChallenge(),
        timeout: CHALLENGE_TTL_MS,
        userVerification: "required",
        allowCredentials: existing.map((row) => ({
          id: row.credential_id,
          transports: knownTransports(row.transports),
        })),
      });
      const [issued] = await tx<{ expires_at: Date }[]>`
        SELECT core.create_webauthn_challenge(
          ${ctx.session.sessionId}, 'authentication', ${options.challenge}
        ) AS expires_at
      `;
      return {
        options,
        expiresAt: issued!.expires_at.toISOString(),
        requestId: request.context.requestId,
      };
    });
  });

  app.post("/api/v1/auth/mfa/passkeys/authentication/verify", verifyLimit, async (request) => {
    const ctx = requireAccountSession(request);
    const parsed = passkeyAuthenticationRequest.safeParse(request.body);
    if (!parsed.success) throw invalidRequest(parsed.error.issues);
    const response = parsed.data.response as unknown as AuthenticationResponseJSON;

    const { expected, credential } = await inTenant(sql, ctx.tenantId, async (tx) => {
      const [row] = await tx<{ challenge: string | null }[]>`
        SELECT core.live_webauthn_challenge(${ctx.session.sessionId}, 'authentication') AS challenge
      `;
      const [found] = await tx<PasskeyRow[]>`
        SELECT id, credential_id, public_key, sign_count::text, transports, name, created_at,
               last_used_at, device_type, backed_up
        FROM core.webauthn_credentials
        WHERE subject_id = ${ctx.subjectId} AND credential_id = ${response.id} AND revoked_at IS NULL
      `;
      return { expected: row?.challenge ?? null, credential: found ?? null };
    });
    if (expected === null) {
      return refuse(request, ctx, "auth.mfa.passkey.verify_failed", new Error("MFA_CHALLENGE_INVALID: none"));
    }
    if (credential === null) {
      return refuse(request, ctx, "auth.mfa.passkey.verify_failed", new Error("MFA_CREDENTIAL_UNKNOWN: none"));
    }

    let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>> | null;
    try {
      verified = await verifyAuthenticationResponse({
        response,
        expectedChallenge: expected,
        expectedOrigin: config.webauthn.origin,
        expectedRPID: config.webauthn.rpId,
        credential: {
          id: credential.credential_id,
          publicKey: new Uint8Array(credential.public_key),
          counter: Number(credential.sign_count),
          transports: knownTransports(credential.transports),
        },
        requireUserVerification: true,
      });
    } catch {
      // A wrong origin, RP ID, challenge or signature, a missing user verification, or a counter
      // that did not increase — the library throws for each; none of them is told apart to the
      // caller.
      verified = null;
    }
    if (!verified?.verified) {
      return refuse(
        request,
        ctx,
        "auth.mfa.passkey.verify_failed",
        unauthorized("MFA_PASSKEY_INVALID", "The passkey could not be verified"),
        { passkeyId: credential.id },
      );
    }

    let ended: boolean;
    try {
      ended = await withTenant(sql, { tenantId: ctx.tenantId }, async (tx) => {
        const [row] = await tx<{ session_ended: boolean }[]>`
          SELECT core.complete_webauthn_authentication(
            ${ctx.session.sessionId}, ${expected}, ${credential.credential_id},
            ${verified.authenticationInfo.newCounter}, ${verified.authenticationInfo.userVerified}
          ) AS session_ended
        `;
        await audit(request, ctx, "auth.mfa.passkey.verified", {
          previousAal: ctx.session.aal, recoveryCompleted: row!.session_ended,
        }, credential.id, tx);
        return row!.session_ended;
      });
    } catch (caught) {
      return refuse(request, ctx, "auth.mfa.passkey.verify_failed", caught, { passkeyId: credential.id });
    }

    return {
      aal: "aal3",
      secondFactor: "passkey",
      recoveryCodes: null,
      sessionEnded: ended,
      requestId: request.context.requestId,
    };
  });

  // --- Passkey management ----------------------------------------------------------------------

  app.patch<{ Params: { passkeyId: string } }>("/api/v1/auth/mfa/passkeys/:passkeyId", async (request) => {
    const ctx = requireAccountSession(request);
    // The request hook already refused a passkeyId that is not a UUID (PATH_PARAM_INVALID).
    const passkeyId = request.params.passkeyId;
    const parsed = renamePasskeyRequest.safeParse(request.body);
    if (!parsed.success) throw invalidRequest(parsed.error.issues);

    const row = await inTenant(sql, ctx.tenantId, async (tx) => {
      const [renamed] = await tx<{ renamed: boolean }[]>`
        SELECT core.rename_webauthn_credential(
          ${ctx.session.sessionId}, ${passkeyId}, ${parsed.data.name}
        ) AS renamed
      `;
      if (!renamed?.renamed) throw notFound("No such active passkey on this account");
      const [found] = await tx<PasskeyRow[]>`
        SELECT id, credential_id, public_key, sign_count::text, transports, name, created_at,
               last_used_at, device_type, backed_up
        FROM core.webauthn_credentials WHERE id = ${passkeyId}
      `;
      await audit(request, ctx, "auth.mfa.passkey.renamed", {}, found!.id, tx);
      return found!;
    });
    return { ...toPasskey(row), requestId: request.context.requestId };
  });

  async function remove(request: FastifyRequest, kind: "passkey" | "totp", id: string | null) {
    const ctx = requireAccountSession(request);
    let result: { revoked_sessions: number; current_session_ended: boolean };
    try {
      result = await withTenant(sql, { tenantId: ctx.tenantId }, async (tx) => {
        const removed = only(await tx<typeof result[]>`
          SELECT * FROM core.remove_authenticator(${ctx.session.sessionId}, ${kind}, ${id}::uuid)
        `);
        await audit(request, ctx, `auth.mfa.${kind}.removed`, {
          revokedSessions: removed.revoked_sessions,
          currentSessionEnded: removed.current_session_ended,
        }, id ?? ctx.session.sessionId, tx);
        return removed;
      });
    } catch (caught) {
      return refuse(request, ctx, `auth.mfa.${kind}.remove_failed`, caught);
    }
    return {
      revokedSessions: result.revoked_sessions,
      currentSessionEnded: result.current_session_ended,
      requestId: request.context.requestId,
    };
  }

  app.post<{ Params: { passkeyId: string } }>("/api/v1/auth/mfa/passkeys/:passkeyId/removal", async (request) =>
    remove(request, "passkey", request.params.passkeyId),
  );
  app.post("/api/v1/auth/mfa/totp/removal", (request) => remove(request, "totp", null));

  // --- TOTP ------------------------------------------------------------------------------------

  app.post("/api/v1/auth/mfa/totp/setup", async (request) => {
    const ctx = requireAccountSession(request);
    const totpId = randomUUID();
    const secret = newTotpSecret();
    const sealed = encryptTotpSecret(totpKey, secret, { totpId, subjectId: ctx.subjectId });

    const { expiresAt, label } = await inTenant(sql, ctx.tenantId, async (tx) => {
      const [issued] = await tx<{ expires_at: Date }[]>`
        SELECT core.begin_totp_enrolment(
          ${totpId}, ${ctx.session.sessionId}, ${sealed.ciphertext}, ${sealed.nonce}
        ) AS expires_at
      `;
      const [subject] = await tx<{ display_name: string }[]>`
        SELECT display_name FROM core.subjects WHERE id = ${ctx.subjectId}
      `;
      await audit(request, ctx, "auth.mfa.totp.setup_started", {}, totpId, tx);
      return { expiresAt: issued!.expires_at, label: subject?.display_name ?? "account" };
    });

    const provisioning = totpProvisioning(secret, label);
    return {
      otpauthUri: provisioning.uri,
      secret: provisioning.base32,
      expiresAt: expiresAt.toISOString(),
      requestId: request.context.requestId,
    };
  });

  /**
   * Checks a TOTP code: counts the attempt first (committed, so a failed or abandoned check stays
   * counted), then verifies the code, then hands the matched step to the database, which refuses
   * a step already used and clears the count.
   */
  async function checkTotp(request: FastifyRequest, pending: boolean) {
    const ctx = requireAccountSession(request);
    const parsed = totpCodeRequest.safeParse(request.body);
    if (!parsed.success) throw invalidRequest(parsed.error.issues);
    const failed = pending ? "auth.mfa.totp.enrol_failed" : "auth.mfa.totp.verify_failed";

    let reserved: {
      totp_id: string;
      secret_ciphertext: Buffer;
      secret_nonce: Buffer;
      last_used_step: string | null;
      attempts_left: number;
    };
    try {
      reserved = only(
        await withTenant(sql, { tenantId: ctx.tenantId }, (tx) =>
        tx<typeof reserved[]>`
          SELECT totp_id, secret_ciphertext, secret_nonce, last_used_step::text, attempts_left
          FROM core.reserve_totp_attempt(${ctx.session.sessionId}, ${pending})
        `,
        ),
      );
    } catch (caught) {
      return refuse(request, ctx, failed, caught);
    }

    let secret: Uint8Array;
    try {
      secret = decryptTotpSecret(
        totpKey,
        { ciphertext: reserved.secret_ciphertext, nonce: reserved.secret_nonce },
        { totpId: reserved.totp_id, subjectId: ctx.subjectId },
      );
    } catch {
      // The key changed (SESSION_SECRET rotated) or the row was tampered with. Either way the
      // code cannot be checked; it is not a wrong code.
      return refuse(
        request,
        ctx,
        failed,
        conflict("MFA_TOTP_UNREADABLE", "This authenticator app can no longer be checked", {
          hint: "Use a passkey or a recovery code, then enrol the app again",
        }),
        { totpId: reserved.totp_id },
      );
    }

    const step = matchTotpStep(secret, parsed.data.code);
    const lastStep = reserved.last_used_step === null ? null : Number(reserved.last_used_step);
    if (step === null || (lastStep !== null && step <= lastStep)) {
      return refuse(
        request,
        ctx,
        failed,
        new AppError("MFA_TOTP_INVALID", "The code is not valid", 401, false, {
          attemptsLeft: reserved.attempts_left,
        }),
        { totpId: reserved.totp_id, replayed: step !== null },
      );
    }

    const codes = pending ? generateRecoveryCodes() : null;
    let result: { activated: boolean; recovery_codes_stored: boolean; session_ended: boolean };
    try {
      result = await withTenant(sql, { tenantId: ctx.tenantId }, async (tx) => {
        const completed = only(await tx<typeof result[]>`
          SELECT * FROM core.complete_totp(
            ${ctx.session.sessionId}, ${reserved.totp_id}, ${step},
            ${codes === null ? null : codes.map(hashRecoveryCode)}::text[]
          )
        `);
        await audit(request, ctx, completed.activated ? "auth.mfa.totp.enrolled" : "auth.mfa.totp.verified", {
          previousAal: ctx.session.aal,
          recoveryCodesGenerated: completed.recovery_codes_stored,
          recoveryCompleted: completed.session_ended,
        }, reserved.totp_id, tx);
        return completed;
      });
    } catch (caught) {
      return refuse(request, ctx, failed, caught, { totpId: reserved.totp_id });
    }

    // A passkey session stays a passkey session: TOTP never lowers it.
    const secondFactor: SecondFactor = ctx.session.secondFactor === "passkey" ? "passkey" : "totp";
    return {
      aal: aalOf(secondFactor),
      secondFactor,
      recoveryCodes: result.recovery_codes_stored ? codes : null,
      sessionEnded: result.session_ended,
      requestId: request.context.requestId,
    };
  }

  app.post("/api/v1/auth/mfa/totp/confirm", verifyLimit, (request) => checkTotp(request, true));
  app.post("/api/v1/auth/mfa/totp/verify", verifyLimit, (request) => checkTotp(request, false));

  // --- Recovery codes --------------------------------------------------------------------------

  app.post("/api/v1/auth/mfa/recovery-codes/verify", verifyLimit, async (request) => {
    const ctx = requireAccountSession(request);
    const parsed = recoveryCodeRequest.safeParse(request.body);
    if (!parsed.success) throw invalidRequest(parsed.error.issues);
    const normalized = normalizeRecoveryCode(parsed.data.code);
    if (normalized === null) {
      return refuse(request, ctx, "auth.mfa.recovery_code.failed", new Error("MFA_RECOVERY_CODE_INVALID: format"));
    }

    let revoked: number;
    try {
      revoked = await withTenant(sql, { tenantId: ctx.tenantId }, async (tx) => {
        const [row] = await tx<{ revoked: number }[]>`
          SELECT core.consume_recovery_code(${ctx.session.sessionId}, ${hashRecoveryCode(normalized)}) AS revoked
        `;
        await audit(request, ctx, "auth.mfa.recovery_code.used", { revokedSessions: row!.revoked }, ctx.session.sessionId, tx);
        return row!.revoked;
      });
    } catch (caught) {
      return refuse(request, ctx, "auth.mfa.recovery_code.failed", caught);
    }

    return {
      aal: "aal2",
      recoveryLimited: true,
      revokedSessions: revoked,
      requestId: request.context.requestId,
    };
  });

  app.post("/api/v1/auth/mfa/recovery-codes", async (request) => {
    const ctx = requireAccountSession(request);
    const codes = generateRecoveryCodes();
    await inTenant(sql, ctx.tenantId, async (tx) => {
      await tx`SELECT core.regenerate_recovery_codes(${ctx.session.sessionId}, ${codes.map(hashRecoveryCode)}::text[])`;
      await audit(request, ctx, "auth.mfa.recovery_codes.regenerated", {}, ctx.session.sessionId, tx);
    });
    return { recoveryCodes: codes, requestId: request.context.requestId };
  });

  // --- Admin MFA reset (journey 6) -------------------------------------------------------------

  const activeTenant = (tenantId: string) =>
    tenantResource(tenantId, { state: "active", statesAllowingAction: ["active"] });

  app.get("/api/v1/admin/mfa-resets", async (request) => {
    const { session, tenantId } = requireReadContext(request);
    assertAuthorized(session, "admin.read", activeTenant(tenantId), sessionFacts(session));
    const { requestId, asOf } = request.context;
    const rows = await withTenant(sql, { tenantId }, (tx) => readResets(tx));
    return { items: rows.map((row) => toReset(row, requestId, asOf)), requestId, asOf };
  });

  app.post("/api/v1/admin/mfa-resets", async (request) => {
    const { session, tenantId, idempotencyKey } = requireMutationContext(request);
    const effectiveRole = assertAuthorized(
      session,
      "admin.mfa_reset.propose",
      activeTenant(tenantId),
      sessionFacts(session),
    );
    const parsed = createMfaResetRequest.safeParse(request.body);
    if (!parsed.success) throw invalidRequest(parsed.error.issues);

    const { requestId, asOf, correlationId } = request.context;
    return withTenant(sql, { tenantId }, (tx) =>
      withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {
        const [target] = await tx<{ kind: string }[]>`
          SELECT kind FROM core.subjects WHERE id = ${parsed.data.subjectId}
        `;
        // A service has no factors to reset; it holds a service token (D7).
        if (!target || target.kind !== "person") throw notFound("Person not found");

        const id = randomUUID();
        try {
          await tx`
            INSERT INTO core.mfa_reset_requests (id, tenant_id, subject_id, reason, requested_by_subject_id)
            VALUES (${id}, ${tenantId}, ${parsed.data.subjectId}, ${parsed.data.reason}, ${session.subjectId})
          `;
        } catch (caught) {
          if (caught instanceof Error && caught.message.includes("mfa_reset_requests_one_pending")) {
            throw conflict("MFA_RESET_ALREADY_PENDING", "A reset for this person is already waiting for a decision");
          }
          // The insert trigger's separation refusal (0118).
          throw translate(caught);
        }

        await recordAudit(tx, {
          tenantId,
          session,
          effectiveRole,
          command: "admin.mfa_reset.proposed",
          resourceType: "mfa_reset_request",
          resourceId: id,
          afterVersion: 1,
          correlationId,
          requestIp: request.clientIp,
          detail: { subjectId: parsed.data.subjectId },
        });

        const [row] = await readResets(tx, id);
        return toReset(row!, requestId, asOf);
      }),
    );
  });

  app.post<{ Params: { resetId: string } }>("/api/v1/admin/mfa-resets/:resetId/decision", async (request, reply) => {
    const { session, tenantId, idempotencyKey } = requireMutationContext(request);
    const effectiveRole = assertAuthorized(
      session,
      "admin.mfa_reset.approve",
      tenantResource(tenantId, { state: "pending", statesAllowingAction: ["pending"] }),
      sessionFacts(session),
    );
    // If-Match before the body — a missing header must not hide behind a body error.
    const expected = requireIfMatch(request);
    const parsed = decideMfaResetRequest.safeParse(request.body);
    if (!parsed.success) throw invalidRequest(parsed.error.issues);

    const { requestId, asOf, correlationId } = request.context;
    return inTenant(sql, tenantId, (tx) =>
      withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {
        const [current] = await readResets(tx, request.params.resetId);
        if (!current) throw notFound("MFA reset request not found");
        assertVersionMatches(expected, current.version, "mfa_reset_request");
        if (current.state !== "pending") {
          throw unprocessable("MFA_RESET_ALREADY_DECIDED", "The request is already decided", { state: current.state });
        }
        // The database refuses both as well; checking here says why.
        if (current.requested_by_subject_id === session.subjectId) {
          throw unprocessable("MFA_RESET_SELF_APPROVAL", "The proposer cannot decide their own proposal", {
            hint: "Another admin decides",
          });
        }
        if (current.subject_id === session.subjectId) {
          throw unprocessable("MFA_RESET_SELF_TARGET", "The person whose factors are reset cannot decide");
        }

        const approved = parsed.data.decision === "approve";
        const [effect] = await tx<
          {
            revoked_sessions: number;
            revoked_authenticators: number;
            voided_recovery_codes: number;
            new_version: number;
            released_elevations: { kind: string; id: string; reason: string }[];
          }[]
        >`
          SELECT * FROM core.decide_mfa_reset(
            ${current.id}, ${session.subjectId}, ${approved}, ${parsed.data.reason}, ${expected}
          )
        `;

        await recordAudit(tx, {
          tenantId,
          session,
          effectiveRole,
          command: approved ? "admin.mfa_reset.approved" : "admin.mfa_reset.rejected",
          resourceType: "mfa_reset_request",
          resourceId: current.id,
          beforeVersion: current.version,
          afterVersion: effect!.new_version,
          correlationId,
          requestIp: request.clientIp,
          detail: {
            subjectId: current.subject_id,
            revokedSessions: effect!.revoked_sessions,
            revokedAuthenticators: effect!.revoked_authenticators,
            voidedRecoveryCodes: effect!.voided_recovery_codes,
            releasedElevations: effect!.released_elevations.length,
          },
        });

        // 0129: an approved reset ends the person's active break-glass elevation; each gets an
        // audit row of its own, attributed to this decision.
        for (const released of effect!.released_elevations) {
          await recordAudit(tx, {
            tenantId,
            session,
            effectiveRole,
            command: "admin.mfa_reset.elevation_released",
            resourceType: released.kind,
            resourceId: released.id,
            correlationId,
            requestIp: request.clientIp,
            detail: { subjectId: current.subject_id, resetId: current.id, reason: released.reason },
          });
        }

        reply.header("etag", etagOf(effect!.new_version));
        const [row] = await readResets(tx, current.id);
        return toReset(row!, requestId, asOf);
      }),
    );
  });
}
