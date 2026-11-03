import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type postgres from "postgres";
import type { Hex as ViemHex } from "viem";
import {
  WALLET_UNAVAILABLE,
  bindWalletByProofRequest,
  disableOwnWalletRequest,
  walletBindingChallengeRequest,
} from "@mpc/api-contract";
import { isPublicDevAddress } from "@mpc/config";
import { LOCAL_CHAIN_ID } from "@mpc/domain";
import { withTenant } from "@mpc/db";
import { ROLE_SELF_BOUND, recordAudit } from "../audit.js";
import type { AppConfig } from "../config.js";
import { hashUserAgent } from "../device.js";
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized, unprocessable } from "../errors.js";
import type { Session } from "../plugins/session.js";
import {
  humanReadableWalletBinding,
  recoverWalletBindingSigner,
  walletBindingMessage,
  walletBindingTypedData,
} from "../services/signing-wallets.js";

/**
 * Signing wallets of the caller's own account — account authentication WP5.
 *
 * The database decides who may do what (migrations 0122, 0130): the session must be a live
 * account session of the subject, at the level of the strongest factor held to bind or replace,
 * aal2 to disable, and never recovery-limited. An account holds one active wallet; binding while
 * it has one replaces it in the same transaction. The API verifies the one thing the database
 * cannot — the signature — and builds the signed message only from the challenge row.
 */

type Tx = postgres.TransactionSql;

interface AccountContext {
  readonly session: Session;
  readonly tenantId: string;
  readonly subjectId: string;
}

function requireAccountSession(request: FastifyRequest): AccountContext {
  const session = request.session;
  if (!session) throw unauthorized("UNAUTHENTICATED", "Authentication required");
  if (session.principal !== "person" || session.tenantId === null || session.subjectId === null) {
    throw forbidden("WALLET_ACCOUNT_SESSION_REQUIRED", "Only a person's account session holds wallets");
  }
  return { session, tenantId: session.tenantId, subjectId: session.subjectId };
}

const DB_REFUSALS: Readonly<Record<string, () => AppError>> = {
  MFA_SESSION_INVALID: () => unauthorized("UNAUTHENTICATED", "The session is no longer valid"),
  MFA_STEP_UP_REQUIRED: () =>
    forbidden("MFA_STEP_UP_REQUIRED", "Prove a second factor first", {
      reason: "AUTHENTICATION_LEVEL_INSUFFICIENT",
      requiredAal: "aal2",
    }),
  MFA_PASSKEY_REQUIRED: () =>
    forbidden("MFA_PASSKEY_REQUIRED", "Sign in with your passkey first", {
      reason: "AUTHENTICATION_LEVEL_INSUFFICIENT",
      requiredAal: "aal3",
    }),
  MFA_RECOVERY_REENROLMENT_REQUIRED: () =>
    forbidden("MFA_RECOVERY_REENROLMENT_REQUIRED", "Enrol a new passkey or authenticator app first"),
  WALLET_CHALLENGE_INVALID: () =>
    unauthorized("WALLET_CHALLENGE_INVALID", "No live binding challenge of this session matches; start again"),
  // One answer wherever the address is bound — this account, another one, another tenant.
  WALLET_UNAVAILABLE: () => conflict(WALLET_UNAVAILABLE, "This wallet cannot be bound to your account"),
  WALLET_ALREADY_ACTIVE: () =>
    conflict("WALLET_ALREADY_ACTIVE", "This wallet already is your account's signing wallet"),
  WALLET_REASON_INVALID: () => badRequest("REQUEST_INVALID", "Not a reason a person gives for disabling a wallet"),
  WALLET_UNKNOWN: () => notFound("No such active wallet on this account"),
};

function translate(caught: unknown): unknown {
  if (!(caught instanceof Error)) return caught;
  const code = /^((?:MFA|WALLET)_[A-Z_]+):/.exec(caught.message)?.[1];
  return code !== undefined && code in DB_REFUSALS ? DB_REFUSALS[code]!() : caught;
}

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

interface WalletRow {
  id: string;
  wallet_address: string;
  chain_id: number;
  bound_via: "operator" | "proof";
  bound_at: Date | null;
  disabled_at: Date | null;
}

/** The active wallet first, then history, newest first. */
function readWallets(tx: Tx, subjectId: string, walletId?: string) {
  return tx<WalletRow[]>`
    SELECT w.id, w.wallet_address, w.chain_id, w.bound_via, w.bound_at, w.disabled_at
    FROM core.wallet_identities w
    WHERE w.subject_id = ${subjectId} ${walletId ? tx`AND w.id = ${walletId}` : tx``}
    ORDER BY (w.disabled_at IS NULL) DESC, w.disabled_at DESC, w.created_at DESC, w.id
  `;
}

function toWallet(row: WalletRow) {
  return {
    id: row.id,
    walletAddress: row.wallet_address,
    chainId: row.chain_id,
    boundVia: row.bound_via,
    boundAt: row.bound_at?.toISOString() ?? null,
    disabledAt: row.disabled_at?.toISOString() ?? null,
  };
}

function replacedWallet(id: string | null, walletAddress: string | null, chainId: number | null) {
  return id === null || walletAddress === null || chainId === null ? null : { id, walletAddress, chainId };
}

export async function registerWalletRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
  config: AppConfig,
): Promise<void> {
  /** Audit row of a self-service wallet action: the person acted on their own account. */
  function audit(
    tx: Tx,
    request: FastifyRequest,
    context: AccountContext,
    entry: { command: string; resourceId: string; detail: Record<string, unknown>; signingWallet?: string },
  ) {
    return recordAudit(tx, {
      tenantId: context.tenantId,
      session: { ...context.session, device: { userAgentHash: hashUserAgent(request.headers["user-agent"]) } },
      effectiveRole: ROLE_SELF_BOUND,
      command: entry.command,
      resourceType: "wallet_identity",
      resourceId: entry.resourceId,
      correlationId: request.context.correlationId,
      requestIp: request.clientIp,
      detail: entry.detail,
      ...(entry.signingWallet ? { signingWallet: entry.signingWallet } : {}),
    });
  }

  app.get("/api/v1/auth/wallets", async (request) => {
    const context = requireAccountSession(request);
    const rows = await inTenant(sql, context.tenantId, (tx) => readWallets(tx, context.subjectId));
    return { items: rows.map(toWallet), requestId: request.context.requestId, asOf: request.context.asOf };
  });

  app.post("/api/v1/auth/wallets/binding-challenges", async (request) => {
    const context = requireAccountSession(request);
    const parsed = walletBindingChallengeRequest.safeParse(request.body);
    if (!parsed.success) throw invalidRequest(parsed.error.issues);
    const address = parsed.data.walletAddress;

    // Anyone can sign as a public development key (anvil, committed fixtures). Bound on a shared
    // chain, its signatures would be whoever's tried the key first.
    if (config.chainId !== LOCAL_CHAIN_ID && isPublicDevAddress(address)) {
      throw unprocessable(
        "WALLET_PUBLIC_DEV_ADDRESS",
        "This is a public development address. Bind a freshly generated wallet on this chain.",
        { chainId: config.chainId },
      );
    }

    const challengeId = randomUUID();
    const nonce = `0x${randomBytes(32).toString("hex")}`;
    const [row] = await inTenant(sql, context.tenantId, (tx) =>
      tx<
        {
          issued_at: Date;
          expires_at: Date;
          tenant_id: string;
          subject_id: string;
          replaces_wallet_id: string | null;
          replaces_wallet_address: string | null;
          replaces_chain_id: number | null;
        }[]
      >`
        SELECT * FROM core.create_wallet_binding_challenge(
          ${context.session.sessionId}, ${challengeId}, ${address}, ${config.chainId}, ${nonce}
        )
      `,
    );
    const replaces = replacedWallet(row!.replaces_wallet_id, row!.replaces_wallet_address, row!.replaces_chain_id);
    const message = walletBindingMessage({
      tenantId: row!.tenant_id,
      subjectId: row!.subject_id,
      walletAddress: address,
      chainId: config.chainId,
      nonce,
      issuedAt: row!.issued_at,
      expiresAt: row!.expires_at,
    });
    const typedData = walletBindingTypedData(config, message);

    return {
      challengeId,
      walletAddress: address,
      chainId: config.chainId,
      replaces,
      humanReadablePayload: humanReadableWalletBinding({
        walletAddress: address,
        chainId: config.chainId,
        expiresAt: row!.expires_at,
        replaces,
      }),
      typedData: {
        domain: typedData.domain,
        types: typedData.types,
        primaryType: typedData.primaryType,
        // bigint does not serialize to JSON; the wallet signs these as integers.
        message: {
          ...message,
          chainId: message.chainId.toString(),
          issuedAt: message.issuedAt.toString(),
          expiresAt: message.expiresAt.toString(),
        },
      },
      expiresAt: row!.expires_at.toISOString(),
      requestId: request.context.requestId,
      asOf: request.context.asOf,
    };
  });

  app.post("/api/v1/auth/wallets", async (request) => {
    const context = requireAccountSession(request);
    const parsed = bindWalletByProofRequest.safeParse(request.body);
    if (!parsed.success) throw invalidRequest(parsed.error.issues);

    return inTenant(sql, context.tenantId, async (tx) => {
      const [challenge] = await tx<
        {
          tenant_id: string;
          subject_id: string;
          wallet_address: string;
          chain_id: number;
          nonce: string;
          issued_at: Date;
          expires_at: Date;
        }[]
      >`
        SELECT * FROM core.live_wallet_binding_challenge(${context.session.sessionId}, ${parsed.data.challengeId})
      `;
      if (!challenge) {
        throw unauthorized("WALLET_CHALLENGE_INVALID", "No live binding challenge of this session matches; start again");
      }

      const signer = await recoverWalletBindingSigner(
        config,
        walletBindingMessage({
          tenantId: challenge.tenant_id,
          subjectId: challenge.subject_id,
          walletAddress: challenge.wallet_address,
          chainId: challenge.chain_id,
          nonce: challenge.nonce,
          issuedAt: challenge.issued_at,
          expiresAt: challenge.expires_at,
        }),
        parsed.data.signature.toLowerCase() as ViemHex,
      );
      // Another key, another chain, another subject or tenant in the signed message, or another
      // nonce: each recovers to some other address.
      if (signer !== challenge.wallet_address) {
        throw badRequest("SIGNATURE_SIGNER_MISMATCH", "The signature is not from the wallet being bound");
      }

      const walletId = randomUUID();
      const [bound] = await tx<
        {
          previous_assurance: string;
          assurance: string;
          replaced_wallet_id: string | null;
          replaced_wallet_address: string | null;
          replaced_chain_id: number | null;
          replaced_bound_via: string | null;
          rebind_of: string | null;
          rebind_same_subject: boolean | null;
        }[]
      >`
        SELECT previous_assurance::text, assurance::text, replaced_wallet_id, replaced_wallet_address,
               replaced_chain_id, replaced_bound_via, rebind_of, rebind_same_subject
        FROM core.bind_wallet_by_proof(
          ${context.session.sessionId}, ${parsed.data.challengeId}, ${signer}, ${walletId}, ${parsed.data.replaceReason}
        )
      `;
      const replaced = replacedWallet(
        bound!.replaced_wallet_id,
        bound!.replaced_wallet_address,
        bound!.replaced_chain_id,
      );

      await audit(tx, request, context, {
        // A replace is one act: the old key disabled and the new one bound, one audit row naming both.
        command: replaced ? "account.wallet.replaced" : "account.wallet.bound",
        resourceId: walletId,
        // The binding is a signed act: the key that signed it is the key bound.
        signingWallet: signer,
        detail: {
          chainId: challenge.chain_id,
          challengeId: parsed.data.challengeId,
          ...(replaced
            ? {
                oldWalletId: replaced.id,
                newWalletId: walletId,
                oldBoundVia: bound!.replaced_bound_via,
                disableReason: "replaced",
                replaceReason: parsed.data.replaceReason,
                revokedSessions: 0,
              }
            : {}),
          // A disabled address bound again: the earlier row stays as it was, attributed to its holder.
          ...(bound!.rebind_of
            ? { rebindOf: bound!.rebind_of, rebindSameSubject: bound!.rebind_same_subject === true }
            : {}),
          subjectAssuranceLevel: bound!.assurance,
          previousSubjectAssuranceLevel: bound!.previous_assurance,
        },
      });

      const [row] = await readWallets(tx, context.subjectId, walletId);
      return { ...toWallet(row!), replaced, requestId: request.context.requestId, asOf: request.context.asOf };
    });
  });

  app.post<{ Params: { walletId: string } }>("/api/v1/auth/wallets/:walletId/disable", async (request) => {
    const context = requireAccountSession(request);
    const parsed = disableOwnWalletRequest.safeParse(request.body);
    if (!parsed.success) throw invalidRequest(parsed.error.issues);

    return inTenant(sql, context.tenantId, async (tx) => {
      const [disabled] = await tx<
        {
          wallet_address: string;
          chain_id: number;
          bound_via: string;
          version: number;
          revoked_sessions: number;
          previous_assurance: string;
          assurance: string;
        }[]
      >`
        SELECT wallet_address, chain_id, bound_via, version, revoked_sessions,
               previous_assurance::text, assurance::text
        FROM core.disable_own_wallet(
          ${context.session.sessionId}, ${request.params.walletId}, ${parsed.data.reasonCode}, ${parsed.data.detail}
        )
      `;
      await audit(tx, request, context, {
        command: "account.wallet.disabled",
        resourceId: request.params.walletId,
        detail: {
          reasonCode: parsed.data.reasonCode,
          chainId: disabled!.chain_id,
          boundVia: disabled!.bound_via,
          revokedSessions: disabled!.revoked_sessions,
          subjectAssuranceLevel: disabled!.assurance,
          previousSubjectAssuranceLevel: disabled!.previous_assurance,
        },
      });
      const [row] = await readWallets(tx, context.subjectId, request.params.walletId);
      return {
        id: request.params.walletId,
        disabledAt: row!.disabled_at!.toISOString(),
        revokedSessions: disabled!.revoked_sessions,
        requestId: request.context.requestId,
      };
    });
  });
}
