/**
 * The invitation token while its acceptance is under way in this tab.
 *
 * Accepting with Google or Microsoft leaves the page for the provider; if the provider cannot
 * vouch for the invited address (`OIDC_EMAIL_CODE_REQUIRED` and its siblings) the person falls
 * back to the emailed code, which needs the token again. It is kept in this tab's session storage
 * only — never a URL, never a cookie the server would see on every request — and cleared once the
 * invitation is accepted. On its own it opens nothing: the code goes to the invited mailbox.
 */
const KEY = "mpc.invitation.pending";

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export const pendingInvitation = {
  keep(token: string): void {
    try {
      storage()?.setItem(KEY, token);
    } catch {
      // Storage blocked (private mode): the code path still works from the link itself.
    }
  },
  read(): string | null {
    const value = storage()?.getItem(KEY) ?? null;
    return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
  },
  clear(): void {
    storage()?.removeItem(KEY);
  },
};
