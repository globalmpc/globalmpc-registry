/** Production E2E keeps production cookie names and Secure flags; it never relaxes the BFF. */
export const BUILT_SERVER = process.env["E2E_WEB_SERVER"] === "built";
export const SESSION_COOKIE = BUILT_SERVER ? "__Host-mpc_session" : "mpc_session";
export const OIDC_COOKIE = BUILT_SERVER ? "__Host-mpc_oidc" : "mpc_oidc";
