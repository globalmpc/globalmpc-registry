import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { TypedDataDefinition } from "viem";
import type { privateKeyToAccount } from "viem/accounts";
import { bearer } from "./db.js";

type Signer = ReturnType<typeof privateKeyToAccount>;

export interface BindingChallenge {
  challengeId: string;
  walletAddress: string;
  chainId: number;
  /** The account's active wallet this binding replaces, or null. */
  replaces: { id: string; walletAddress: string; chainId: number } | null;
  humanReadablePayload: string;
  expiresAt: string;
  typedData: {
    domain: Record<string, unknown>;
    types: Record<string, { name: string; type: string }[]>;
    primaryType: string;
    message: Record<string, unknown>;
  };
}

export function requestBindingChallenge(
  app: FastifyInstance,
  token: string,
  walletAddress: string,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: "/api/v1/auth/wallets/binding-challenges",
    headers: bearer(token),
    payload: { walletAddress },
  });
}

/**
 * Signs a binding challenge as a wallet would, optionally with fields of the message or domain
 * replaced — what a tampered or misdirected signature would have covered.
 */
export function signBindingChallenge(
  signer: Signer,
  challenge: BindingChallenge,
  overrides: { message?: Record<string, unknown>; domain?: Record<string, unknown> } = {},
): Promise<`0x${string}`> {
  const { typedData } = challenge;
  const numeric = (typedData.types[typedData.primaryType] ?? [])
    .filter((field) => field.type.startsWith("uint"))
    .map((field) => field.name);
  const merged = { ...typedData.message, ...overrides.message };
  const message = Object.fromEntries(
    Object.entries(merged).map(([key, value]) => (numeric.includes(key) ? [key, BigInt(value as string)] : [key, value])),
  );
  return signer.signTypedData({
    domain: { ...typedData.domain, ...overrides.domain },
    types: typedData.types,
    primaryType: typedData.primaryType,
    message,
  } as unknown as TypedDataDefinition);
}

export function submitBinding(
  app: FastifyInstance,
  token: string,
  body: { challengeId: string; signature: string; replaceReason?: string },
): Promise<LightMyRequestResponse> {
  return app.inject({ method: "POST", url: "/api/v1/auth/wallets", headers: bearer(token), payload: body });
}

/** The whole ceremony: challenge for `signer`'s address, sign, submit. */
export async function bindWalletByProof(
  app: FastifyInstance,
  token: string,
  signer: Signer,
  replaceReason?: string,
): Promise<LightMyRequestResponse> {
  const challenge = await requestBindingChallenge(app, token, signer.address.toLowerCase());
  if (challenge.statusCode !== 200) return challenge;
  const body = challenge.json() as BindingChallenge;
  return submitBinding(app, token, {
    challengeId: body.challengeId,
    signature: await signBindingChallenge(signer, body),
    ...(replaceReason ? { replaceReason } : {}),
  });
}
