import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import {
  passkeyAuthenticationOptions,
  passkeyRegistrationOptions,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
  type FactorResult,
} from "./account-api";

/**
 * Passkey ceremonies — `navigator.credentials.create/get` with the options the server issued.
 *
 * The browser checks the relying party (the server's `WEBAUTHN_RP_ID`) against this page's
 * origin, and the server checks the origin and challenge in the signed client data; nothing here
 * decides whether a passkey is good. A cancelled prompt rejects with `NotAllowedError`.
 */
export async function enrolPasskey(name?: string): Promise<FactorResult> {
  const { options } = await passkeyRegistrationOptions();
  const response = await startRegistration({
    optionsJSON: options as unknown as PublicKeyCredentialCreationOptionsJSON,
  });
  return verifyPasskeyRegistration(response, name);
}

export async function provePasskey(): Promise<FactorResult> {
  const { options } = await passkeyAuthenticationOptions();
  const response = await startAuthentication({
    optionsJSON: options as unknown as PublicKeyCredentialRequestOptionsJSON,
  });
  return verifyPasskeyAuthentication(response);
}
