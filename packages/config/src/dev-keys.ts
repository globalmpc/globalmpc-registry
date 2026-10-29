/**
 * Public development keys.
 *
 * Two kinds, both public because they are written down where anyone can read them:
 *
 * - anvil and hardhat derive their default accounts from the public mnemonic
 *   "test test test test test test test test test test test junk". Every local node prints
 *   their private keys, and countless guides copy them.
 * - Fixture keys committed to this repository (`config/local-secrets/`, Compose defaults). A
 *   committed key is public the moment it is pushed.
 *
 * On any shared chain the funds and roles such a key holds belong to whoever uses it first — on
 * a testnet, someone could anchor garbage roots or log in as a service identity.
 *
 * Compared by address, not by key: the list stays public data, and a key given with different
 * casing or through a secret reference still matches. `apps/anchor-worker/test/dev-keys.test.ts`
 * derives both lists from their sources, so a new committed fixture missing here fails it.
 */

/** The local chain (anvil), the only one where these keys are expected. */
const DEV_KEY_CHAIN_ID = 31337;

/**
 * Accounts 0–19 of the anvil/hardhat mnemonic, lowercase: hardhat's default 20 (anvil prints the
 * first 10). Any index is derivable, so this is the set the tools hand out, not every address the
 * mnemonic can make; a key chosen from it by hand at a higher index is outside any list.
 */
export const ANVIL_DEV_ADDRESSES: readonly string[] = [
  "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
  "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65",
  "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc",
  "0x976ea74026e726554db657fa54763abd0c3a0aa9",
  "0x14dc79964da2c08b23698b3d3cc7ca32193d9955",
  "0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f",
  "0xa0ee7a142d267c1f36714e4a8f75612f20a79720",
  "0xbcd4042de499d14e55001ccbb24a551f3b954096",
  "0x71be63f3384f5fb98995898a86b02fb2426c5788",
  "0xfabb0ac9d68b0b445fb7357272ff202c5651694a",
  "0x1cbd3b2770909d4e10f157cabc84c7264073c9ec",
  "0xdf3e18d64bc6a983f673ab319ccae4f1a57c7097",
  "0xcd3b766ccdd6ae721141f452c550ca635964ce71",
  "0x2546bcd3c84621e976d8185a91a922ae77ecec30",
  "0xbda5747bfd65f08deb54cb465eb87d40e51b197e",
  "0xdd2fd4581271e230360230f9337d5c0430bf44c0",
  "0x8626f6940e2eb28930efb4cef49b2d1f2c9c1199",
];

/**
 * Addresses of committed fixture keys that are not anvil accounts, lowercase.
 *
 * - `config/local-secrets/scan_service_key`, also the Compose `SCAN_SERVICE_PRIVATE_KEY` default.
 *
 * (`config/local-secrets/anchor_signer_key` and the Compose and CI anchor signer are anvil
 * account 0, already above.)
 */
export const COMMITTED_FIXTURE_ADDRESSES: readonly string[] = [
  "0xda519e0e438d9836dc7e9ca61117e43a9773b598",
];

export const PUBLIC_DEV_ADDRESSES: readonly string[] = [
  ...ANVIL_DEV_ADDRESSES,
  ...COMMITTED_FIXTURE_ADDRESSES,
];

export function isPublicDevAddress(address: string): boolean {
  return PUBLIC_DEV_ADDRESSES.includes(address.toLowerCase());
}

/**
 * Refuses a public development key anywhere but the local chain.
 *
 * `name` is the variable the key came from. The message names it and the chain, never the key.
 */
export function assertNotDevKey(name: string, address: string, chainId: number): void {
  if (chainId !== DEV_KEY_CHAIN_ID && isPublicDevAddress(address)) {
    throw new Error(
      `${name} is a public development key (anvil/hardhat or a committed fixture), accepted only on chain ${DEV_KEY_CHAIN_ID}; ` +
        `generate a fresh key for chain ${chainId}`,
    );
  }
}
