import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type postgres from "postgres";
import {
  OIDC_ACCOUNT_NOT_FOUND,
  OIDC_EMAIL_CODE_REQUIRED,
  OIDC_IDENTITY_UNAVAILABLE,
  oidcCallbackRequest,
  oidcProvider,
  oidcSignInStartRequest,
  type OidcProvider,
} from "@mpc/api-contract";
import { withTenant } from "@mpc/db";
import { createAccountCrypto } from "../account-crypto.js";
import { ROLE_SELF_BOUND, recordAudit } from "../audit.js";
import type { AppConfig } from "../config.js";
import { hashUserAgent } from "../device.js";
import {
  AppError,
  badRequest,
  conflict,
  forbidden,
  notFound,
  tooManyRequests,
  unauthorized,
  unavailable,
  unprocessable,
} from "../errors.js";
import type { Session } from "../plugins/session.js";
import { hashToken, newSessionToken, SESSION_TTL_SECONDS } from "../plugins/session-token.js";
import {
  deriveOidcTxKey,
  OidcError,
  OidcProviders,
  openFlowSecrets,
  randomFlowToken,
  sealFlowSecrets,
  sha256Hex,
  type FlowSecrets,
  type OidcFetch,
  type VerifiedIdentity,
} from "../services/oidc.js";
import { codeRefusal, issuedSessionResponse, recordAccountAudit } from "./account-shared.js";

/**
 * Google and Microsoft sign-in, linking and unlinking — account authentication WP4.
 *
 * **Who decides what.** `services/oidc.ts` runs the code flow and validates the ID token;
 * everything else — single use of a `state`, the browser binding, which session may link, that
 * an identity is matched only by its key, that an invitation is accepted only for the address the
 * provider verified, which sessions end on unlink — is decided by 0121's functions. The route
 * never states a factor: a `google` / `microsoft` session exists only because the database
 * completed a login transaction in the same transaction (0120).
 *
 * **Two steps per callback.** The `state` is claimed and committed first, so a second callback
 * with it fails whatever happens next; then the code is exchanged (a network call, outside any
 * database transaction); then the completion runs in its own transaction. A failure in between
 * leaves the transaction claimed and dead.
 *
 * **Refusals do not echo the provider.** An `error` from the provider is reduced to two codes,
 * a failed token to one, and nothing from the provider's response reaches the client or the
 * audit trail beyond a library error code.
 */

type Tx = postgres.TransactionSql;

interface StartRow {
  status: "started" | "rate_limited" | "session_invalid" | "step_up_required" | "invitation_invalid";
  retry_after_seconds: number;
  tenant_id: string | null;
  subject_id: string | null;
  invitation_id: string | null;
  expires_at: Date | null;
}

interface ClaimRow {
  status: "claimed" | "state_invalid" | "state_expired";
  transaction_id: string | null;
  purpose: "sign_in" | "link" | "invitation_accept" | null;
  secret: Buffer | null;
  nonce_hash: string | null;
  redirect_uri: string | null;
  tenant_id: string | null;
  invitation_id: string | null;
}

interface IdentityRow {
  id: string;
  provider: OidcProvider;
  issuer: string;
  idp_tenant: string | null;
  linked_via: "link" | "invitation";
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

function toIdentity(row: IdentityRow) {
  return {
    id: row.id,
    provider: row.provider,
    issuer: row.issuer,
    idpTenant: row.idp_tenant,
    linkedVia: row.linked_via,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
  };
}

const stateInvalid = () =>
  unauthorized("OIDC_STATE_INVALID", "This sign-in link is no longer valid. Start again");

/** The provider's `error` → one of two generic codes. Its text is never forwarded. */
function providerRefusal(error: string): AppError {
  return error === "access_denied"
    ? unauthorized("OIDC_ACCESS_DENIED", "Sign-in was cancelled at the provider")
    : unauthorized("OIDC_PROVIDER_ERROR", "The provider could not complete the sign-in. Start again");
}

function verificationRefusal(caught: OidcError): AppError {
  switch (caught.failure) {
    case "provider_unavailable":
      return unavailable("OIDC_PROVIDER_UNAVAILABLE", "The sign-in provider could not be reached. Try again");
    case "tenant_not_allowed":
      return forbidden("OIDC_TENANT_NOT_ALLOWED", "Accounts of this organisation's directory cannot sign in here");
    default:
      return unauthorized("OIDC_TOKEN_INVALID", "The sign-in could not be verified. Start again");
  }
}

/** Database refusals raised by 0121 / 0116 (`CODE: …`) → API errors. Anything else propagates. */
const DB_REFUSALS: Readonly<Record<string, () => AppError>> = {
  MFA_SESSION_INVALID: () => unauthorized("UNAUTHENTICATED", "The session is no longer valid"),
  OIDC_TRANSACTION_INVALID: stateInvalid,
  MFA_STEP_UP_REQUIRED: () =>
    forbidden("MFA_STEP_UP_REQUIRED", "Prove a second factor first", {
      reason: "AUTHENTICATION_LEVEL_INSUFFICIENT",
      requiredAal: "aal2",
    }),
  MFA_RECOVERY_REENROLMENT_REQUIRED: () =>
    forbidden("MFA_RECOVERY_REENROLMENT_REQUIRED", "Enrol a new passkey or authenticator app first"),
  OIDC_IDENTITY_UNKNOWN: () => notFound("No such linked identity on this account"),
  OIDC_LAST_SIGN_IN_METHOD: () =>
    unprocessable("OIDC_LAST_SIGN_IN_METHOD", "The last way to sign in to this account cannot be unlinked"),
};

function translate(caught: unknown): unknown {
  if (!(caught instanceof Error)) return caught;
  const code = /^([A-Z][A-Z_]+):/.exec(caught.message)?.[1];
  return code !== undefined && code in DB_REFUSALS ? DB_REFUSALS[code]!() : caught;
}

interface AccountContext {
  readonly session: Session & { readonly tenantId: string; readonly subjectId: string };
  readonly tenantId: string;
  readonly subjectId: string;
}

/** A person's account session in a tenant. Services do not link. */
function requireAccountSession(request: FastifyRequest): AccountContext {
  const session = request.session;
  if (!session) throw unauthorized("UNAUTHENTICATED", "Authentication required");
  if (session.principal !== "person" || session.tenantId === null || session.subjectId === null) {
    throw forbidden("OIDC_ACCOUNT_SESSION_REQUIRED", "Only an account session can link a sign-in method");
  }
  return {
    session: { ...session, tenantId: session.tenantId, subjectId: session.subjectId },
    tenantId: session.tenantId,
    subjectId: session.subjectId,
  };
}

export async function registerOidcRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
  config: AppConfig,
  fetchImpl?: OidcFetch,
): Promise<void> {
  const keys = createAccountCrypto(config.sessionSecret);
  const txKey = deriveOidcTxKey(config.sessionSecret);
  const providers = new OidcProviders(config.oidc, fetchImpl);
  const authRateLimit = { rateLimit: { max: config.authRateLimitMax, timeWindow: "1 minute" } };

  function enabledProvider(request: FastifyRequest): OidcProvider {
    const parsed = oidcProvider.safeParse((request.params as { provider?: unknown }).provider);
    // Not a provider at all is a malformed path; a provider this deployment has not turned on is
    // a route that is not there for it.
    if (!parsed.success) throw badRequest("REQUEST_INVALID", "Unknown sign-in provider");
    if (!providers.enabled(parsed.data)) {
      throw new AppError("OIDC_PROVIDER_DISABLED", "This sign-in provider is not available", 404, false);
    }
    return parsed.data;
  }

  /** Generates the flow's secrets and the provider URL, and records the transaction. */
  async function startFlow(
    request: FastifyRequest,
    provider: OidcProvider,
    record: (row: {
      id: string;
      stateHash: string;
      bindingHash: string;
      nonceHash: string;
      sealed: Buffer;
      redirectUri: string;
    }) => Promise<StartRow>,
  ) {
    const state = randomFlowToken();
    const binding = randomFlowToken();
    const secrets: FlowSecrets = { codeVerifier: randomFlowToken(), nonce: randomFlowToken() };
    const id = randomUUID();

    let authorizationUrl: string;
    try {
      authorizationUrl = await providers.authorizationUrl(provider, { state, ...secrets });
    } catch (caught) {
      if (caught instanceof OidcError) {
        request.log.warn({ provider, reason: caught.reason }, "oidc discovery failed");
        throw verificationRefusal(caught);
      }
      throw caught;
    }

    const row = await record({
      id,
      stateHash: sha256Hex(state),
      bindingHash: sha256Hex(binding),
      nonceHash: sha256Hex(secrets.nonce),
      sealed: sealFlowSecrets(txKey, id, secrets),
      redirectUri: providers.redirectUri(provider),
    });
    switch (row.status) {
      case "started":
        return {
          authorizationUrl,
          browserBinding: binding,
          expiresAt: row.expires_at!.toISOString(),
        };
      case "rate_limited":
        throw tooManyRequests("RATE_LIMITED", "Too many attempts. Try again later", {
          retryAfterSeconds: String(row.retry_after_seconds),
        });
      case "invitation_invalid":
        throw codeRefusal("invitation_invalid", null);
      case "session_invalid":
        throw unauthorized("UNAUTHENTICATED", "The session is no longer valid");
      default:
        throw DB_REFUSALS["MFA_STEP_UP_REQUIRED"]!();
    }
  }

  /** Claims the transaction a callback names; a refusal changes nothing (or spends it, if expired). */
  async function claim(
    provider: OidcProvider,
    body: { state: string; browserBinding: string },
    sessionId: string | null,
  ): Promise<ClaimRow & { transaction_id: string }> {
    const [row] = await sql<ClaimRow[]>`
      SELECT * FROM core.claim_oidc_transaction(
        ${sha256Hex(body.state)}, ${sha256Hex(body.browserBinding)}, ${provider}::core.oidc_provider, ${sessionId}
      )
    `;
    if (row!.status !== "claimed") throw stateInvalid();
    return row as ClaimRow & { transaction_id: string };
  }

  /**
   * From a claimed transaction to a verified identity, or a refusal. A provider `error` and a
   * failed token are audited when the flow already belongs to a tenant (link, invitation); a
   * sign-in that failed belongs to nobody yet.
   */
  async function verify(
    request: FastifyRequest,
    provider: OidcProvider,
    claimed: ClaimRow & { transaction_id: string },
    body: { state: string; code?: string | undefined; iss?: string | undefined; error?: string | undefined },
    subjectId: string | null,
  ): Promise<VerifiedIdentity> {
    const fail = async (reason: string, refusal: AppError): Promise<never> => {
      request.log.info({ provider, purpose: claimed.purpose, reason }, "oidc callback refused");
      if (claimed.tenant_id !== null) {
        await sql.begin((tx) =>
          recordAccountAudit(tx, request, {
            tenantId: claimed.tenant_id!,
            subjectId,
            command: "auth.oidc.failed",
            resourceType: "oidc_login_transaction",
            resourceId: claimed.transaction_id,
            detail: { provider, purpose: claimed.purpose, reason },
          }),
        );
      }
      throw refusal;
    };

    if (body.error !== undefined) {
      return fail(body.error === "access_denied" ? "idp_access_denied" : "idp_error", providerRefusal(body.error));
    }

    let secrets: FlowSecrets;
    try {
      secrets = openFlowSecrets(txKey, claimed.transaction_id, claimed.secret!);
    } catch {
      // A rotated SESSION_SECRET, or bytes that are not this row's.
      return fail("sealed_secret_unreadable", stateInvalid());
    }
    if (sha256Hex(secrets.nonce) !== claimed.nonce_hash) {
      return fail("nonce_hash_mismatch", stateInvalid());
    }

    try {
      return await providers.exchange(provider, {
        redirectUri: claimed.redirect_uri!,
        state: body.state,
        code: body.code!,
        iss: body.iss,
        secrets,
      });
    } catch (caught) {
      if (!(caught instanceof OidcError)) throw caught;
      return fail(caught.reason, verificationRefusal(caught));
    }
  }

  // --- Sign-in and invitation acceptance (unauthenticated) ------------------

  app.post("/api/v1/auth/oidc/:provider/start", { config: authRateLimit }, async (request) => {
    const provider = enabledProvider(request);
    const parsed = oidcSignInStartRequest.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest("REQUEST_INVALID", "Request format is invalid", { issues: parsed.error.issues });
    }
    const invitation = parsed.data.purpose === "invitation_accept" ? parsed.data : null;

    return startFlow(request, provider, (row) =>
      sql.begin(async (tx) => {
        const [started] = await tx<StartRow[]>`
          SELECT * FROM core.start_oidc_transaction(
            ${row.id}, ${provider}::core.oidc_provider, ${parsed.data.purpose}::core.oidc_purpose,
            ${row.stateHash}, ${row.bindingHash}, ${row.nonceHash}, ${row.sealed}, ${row.redirectUri},
            NULL, ${invitation ? hashToken(invitation.invitationToken) : null}, ${invitation?.displayName ?? null},
            ${keys.ipKey(request.clientIp)}
          )
        `;
        if (started!.status === "started" && started!.tenant_id !== null) {
          await recordAccountAudit(tx, request, {
            tenantId: started!.tenant_id,
            subjectId: null,
            command: "auth.oidc.started",
            resourceType: "oidc_login_transaction",
            resourceId: row.id,
            detail: { provider, purpose: parsed.data.purpose, invitationId: started!.invitation_id },
          });
        }
        return started!;
      }),
    );
  });

  app.post("/api/v1/auth/oidc/:provider/callback", { config: authRateLimit }, async (request) => {
    const provider = enabledProvider(request);
    const parsed = oidcCallbackRequest.safeParse(request.body);
    if (!parsed.success) throw badRequest("REQUEST_INVALID", "Request format is invalid");
    const body = parsed.data;

    const claimed = await claim(provider, body, null);
    const identity = await verify(request, provider, claimed, body, null);
    const token = newSessionToken();
    const sessionId = randomUUID();
    const emailHash = identity.reportedEmail === null ? null : keys.emailKey(identity.reportedEmail);

    if (claimed.purpose === "sign_in") {
      const row = await sql.begin(async (tx) => {
        const [completed] = await tx<
          { status: string; tenant_id: string | null; subject_id: string | null; identity_id: string | null; expires_at: Date | null }[]
        >`
          SELECT * FROM core.complete_oidc_sign_in(
            ${claimed.transaction_id}, ${identity.issuer}, ${identity.subjectKey},
            ${sessionId}, ${hashToken(token)}, ${SESSION_TTL_SECONDS}
          )
        `;
        if (completed!.status === "session_created") {
          for (const entry of [
            {
              command: "auth.oidc.signed_in",
              resourceType: "external_identity",
              resourceId: completed!.identity_id,
              detail: { provider, transactionId: claimed.transaction_id },
            },
            {
              command: "auth.session.created",
              resourceType: "session",
              resourceId: sessionId,
              detail: { firstFactor: provider, aal: "aal1", identityId: completed!.identity_id },
            },
          ]) {
            await recordAccountAudit(tx, request, {
              tenantId: completed!.tenant_id!,
              subjectId: completed!.subject_id,
              ...entry,
            });
          }
        }
        return completed!;
      }).catch((caught: unknown) => {
        throw translate(caught);
      });

      if (row.status !== "session_created") {
        // No account has this identity. The answer is the same whatever the token's email is,
        // and nothing is created or linked.
        request.log.info({ provider }, "oidc sign-in for an identity that is not linked");
        throw unauthorized(OIDC_ACCOUNT_NOT_FOUND, "No account is linked to this sign-in. Sign in with your email, then link it");
      }
      return issuedSessionResponse(sql, request, token, row.expires_at!);
    }

    // invitation_accept
    if (identity.emailCodeRequired) {
      // Google's `email_verified` for an address Google does not manage dates from the Google
      // account's sign-up; the address may have changed hands since. The invitation is untouched
      // and still accepts the emailed code.
      request.log.info({ provider }, "oidc invitation refused: address not managed by the provider");
      if (claimed.tenant_id !== null) {
        await sql.begin((tx) =>
          recordAccountAudit(tx, request, {
            tenantId: claimed.tenant_id!,
            subjectId: null,
            command: "auth.oidc.failed",
            resourceType: "oidc_login_transaction",
            resourceId: claimed.transaction_id,
            detail: { provider, purpose: "invitation_accept", invitationId: claimed.invitation_id, reason: "email_code_required" },
          }),
        );
      }
      throw forbidden(
        OIDC_EMAIL_CODE_REQUIRED,
        "This address cannot be confirmed through Google. Accept the invitation with the emailed code",
      );
    }
    const subjectId = randomUUID();
    const identityId = randomUUID();
    const row = await sql.begin(async (tx) => {
      const [completed] = await tx<
        {
          status: string;
          tenant_id: string | null;
          subject_id: string | null;
          organization_id: string | null;
          invitation_id: string | null;
          identity_id: string | null;
          expires_at: Date | null;
        }[]
      >`
        SELECT * FROM core.complete_oidc_invitation(
          ${claimed.transaction_id}, ${identity.issuer}, ${identity.subjectKey}, ${identity.idpTenant},
          ${identity.verifiedEmail}, ${emailHash}, ${identityId}, ${subjectId},
          ${sessionId}, ${hashToken(token)}, ${SESSION_TTL_SECONDS}
        )
      `;
      const result = completed!;
      if (result.tenant_id === null) return result;
      if (result.status !== "session_created") {
        await recordAccountAudit(tx, request, {
          tenantId: result.tenant_id,
          subjectId: null,
          command: "auth.oidc.failed",
          resourceType: "oidc_login_transaction",
          resourceId: claimed.transaction_id,
          detail: {
            provider,
            purpose: "invitation_accept",
            invitationId: result.invitation_id,
            reason: identity.verifiedEmail === null && result.status === "email_mismatch" ? "email_not_verified" : result.status,
          },
        });
        return result;
      }
      for (const entry of [
        {
          command: "auth.invitation.accepted",
          resourceType: "invitation",
          resourceId: result.invitation_id,
          detail: { emailHash, organizationId: result.organization_id, via: provider },
        },
        {
          command: "auth.oidc.identity_linked",
          resourceType: "external_identity",
          resourceId: result.identity_id,
          detail: { provider, linkedVia: "invitation", emailHash },
        },
        {
          command: "auth.session.created",
          resourceType: "session",
          resourceId: sessionId,
          detail: { firstFactor: provider, aal: "aal1", identityId: result.identity_id },
        },
      ]) {
        await recordAccountAudit(tx, request, { tenantId: result.tenant_id, subjectId: result.subject_id, ...entry });
      }
      return result;
    }).catch((caught: unknown) => {
      throw translate(caught);
    });

    switch (row.status) {
      case "session_created":
        return issuedSessionResponse(sql, request, token, row.expires_at!);
      case "email_mismatch":
        throw identity.verifiedEmail === null
          ? forbidden("OIDC_EMAIL_NOT_VERIFIED", "The provider has not verified this account's email address. Use the emailed code instead")
          : forbidden("OIDC_EMAIL_MISMATCH", "This account's email address is not the invited one. Use the emailed code instead");
      case "identity_unavailable":
        throw conflict(OIDC_IDENTITY_UNAVAILABLE, "This sign-in cannot be linked to a new account");
      default:
        // invitation_invalid, email_unavailable — as the code acceptance answers them.
        throw codeRefusal("invitation_invalid", null);
    }
  });

  // --- Linking from a session (aal2+) ---------------------------------------

  async function audit(
    tx: Tx,
    request: FastifyRequest,
    ctx: AccountContext,
    command: string,
    resourceType: string,
    resourceId: string | null,
    detail: Record<string, unknown>,
  ) {
    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      session: { ...ctx.session, device: { userAgentHash: hashUserAgent(request.headers["user-agent"]) } },
      effectiveRole: ROLE_SELF_BOUND,
      command,
      resourceType,
      ...(resourceId ? { resourceId } : {}),
      correlationId: request.context.correlationId,
      requestIp: request.clientIp,
      detail: { subjectId: ctx.subjectId, ...detail },
    });
  }

  app.post("/api/v1/auth/oidc/:provider/link/start", { config: authRateLimit }, async (request) => {
    const ctx = requireAccountSession(request);
    const provider = enabledProvider(request);
    return startFlow(request, provider, (row) =>
      withTenant(sql, { tenantId: ctx.tenantId }, async (tx) => {
        const [started] = await tx<StartRow[]>`
          SELECT * FROM core.start_oidc_transaction(
            ${row.id}, ${provider}::core.oidc_provider, 'link'::core.oidc_purpose,
            ${row.stateHash}, ${row.bindingHash}, ${row.nonceHash}, ${row.sealed}, ${row.redirectUri},
            ${ctx.session.sessionId}, NULL, NULL, ${keys.ipKey(request.clientIp)}
          )
        `;
        return started!;
      }),
    );
  });

  app.post("/api/v1/auth/oidc/:provider/link/callback", { config: authRateLimit }, async (request) => {
    const ctx = requireAccountSession(request);
    const provider = enabledProvider(request);
    const parsed = oidcCallbackRequest.safeParse(request.body);
    if (!parsed.success) throw badRequest("REQUEST_INVALID", "Request format is invalid");
    const body = parsed.data;

    const claimed = await claim(provider, body, ctx.session.sessionId);
    const identity = await verify(request, provider, claimed, body, ctx.subjectId);
    const identityId = randomUUID();
    const emailHash = identity.reportedEmail === null ? null : keys.emailKey(identity.reportedEmail);

    const result = await withTenant(sql, { tenantId: ctx.tenantId }, async (tx) => {
      const [completed] = await tx<{ status: string; identity_id: string | null }[]>`
        SELECT * FROM core.complete_oidc_link(
          ${claimed.transaction_id}, ${ctx.session.sessionId}, ${identity.issuer}, ${identity.subjectKey},
          ${identity.idpTenant}, ${emailHash}, ${identityId}
        )
      `;
      if (completed!.status === "linked") {
        await audit(tx, request, ctx, "auth.oidc.identity_linked", "external_identity", identityId, {
          provider,
          linkedVia: "link",
          emailHash,
        });
        const [row] = await tx<IdentityRow[]>`
          SELECT * FROM core.list_external_identities(${ctx.session.sessionId}) WHERE id = ${identityId}
        `;
        return { status: "linked" as const, identity: toIdentity(row!) };
      }
      await audit(tx, request, ctx, "auth.oidc.link_refused", "oidc_login_transaction", claimed.transaction_id, {
        provider,
        reason: completed!.status,
      });
      return { status: completed!.status, identity: null };
    }).catch((caught: unknown) => {
      throw translate(caught);
    });

    switch (result.status) {
      case "linked":
        return result.identity!;
      case "unavailable":
        throw conflict(OIDC_IDENTITY_UNAVAILABLE, "This sign-in cannot be linked to this account");
      case "provider_already_linked":
        throw conflict(
          "OIDC_PROVIDER_ALREADY_LINKED",
          "This account already has a sign-in of this provider. Unlink it first",
        );
      default:
        throw DB_REFUSALS["MFA_STEP_UP_REQUIRED"]!();
    }
  });

  app.get("/api/v1/auth/identities", async (request) => {
    const ctx = requireAccountSession(request);
    const rows = await withTenant(sql, { tenantId: ctx.tenantId }, (tx) => tx<IdentityRow[]>`
      SELECT * FROM core.list_external_identities(${ctx.session.sessionId})
    `);
    return { items: rows.map(toIdentity), requestId: request.context.requestId, asOf: request.context.asOf };
  });

  app.post<{ Params: { identityId: string } }>("/api/v1/auth/identities/:identityId/unlink", async (request) => {
    const ctx = requireAccountSession(request);
    const identityId = request.params.identityId;
    const [row] = await withTenant(sql, { tenantId: ctx.tenantId }, async (tx) => {
      const unlinked = await tx<{ revoked_sessions: number; current_session_ended: boolean }[]>`
        SELECT * FROM core.unlink_external_identity(${ctx.session.sessionId}, ${identityId})
      `;
      await audit(tx, request, ctx, "auth.oidc.identity_unlinked", "external_identity", identityId, {
        revokedSessions: unlinked[0]!.revoked_sessions,
        currentSessionEnded: unlinked[0]!.current_session_ended,
      });
      return unlinked;
    }).catch((caught: unknown) => {
      throw translate(caught);
    });
    return { revokedSessions: row!.revoked_sessions, currentSessionEnded: row!.current_session_ended };
  });
}
