import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { TypedDataDefinition } from "viem";
import { idempotencyKey, type TestAccount } from "./db.js";

/**
 * Records a gate decision the way the screen does: signature request → wallet signature →
 * submission (spec 11 §11.3).
 *
 * Returns the refusal as is when the signature request is refused, so a test can assert on why.
 */
export async function requestGateDecisionSignature(
  app: FastifyInstance,
  token: string,
  projectId: string,
  content: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/gate-decisions/signature-requests`,
    headers: { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey() },
    payload: content as never,
  });
}

interface SignatureRequestBody {
  signatureRequestId: string;
  typedData: {
    domain: Record<string, unknown>;
    types: Record<string, { name: string; type: string }[]>;
    primaryType: string;
    message: Record<string, unknown>;
  };
}

/** Signs a signature request's typed data with the given account, as a wallet would. */
export async function signGateDecision(
  signer: TestAccount,
  request: SignatureRequestBody,
): Promise<string> {
  const { typedData } = request;
  const numeric = (typedData.types[typedData.primaryType] ?? [])
    .filter((field) => field.type.startsWith("uint"))
    .map((field) => field.name);
  const message = Object.fromEntries(
    Object.entries(typedData.message).map(([key, value]) =>
      numeric.includes(key) ? [key, BigInt(value as string)] : [key, value],
    ),
  );
  return signer.account.signTypedData({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message,
  } as unknown as TypedDataDefinition);
}

export function submitGateDecision(
  app: FastifyInstance,
  token: string,
  projectId: string,
  body: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/gate-decisions`,
    headers: { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey() },
    payload: body as never,
  });
}

/** Request, sign with `signer`, submit. */
export async function decideSigned(
  app: FastifyInstance,
  token: string,
  signer: TestAccount,
  projectId: string,
  content: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  const requested = await requestGateDecisionSignature(app, token, projectId, content);
  if (requested.statusCode !== 200) return requested;
  const body = requested.json() as SignatureRequestBody;
  const signature = await signGateDecision(signer, body);
  return submitGateDecision(app, token, projectId, {
    ...content,
    signatureRequestId: body.signatureRequestId,
    signature,
  });
}
