"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getAuthMethods, type AuthMethods } from "@/lib/account-api";
import { AUTH_COPY } from "@/lib/copy";
import { isAccountSession, useSession } from "@/lib/session";
import { FactorsSection } from "@/components/settings/FactorsSection";
import { IdentitiesSection } from "@/components/settings/IdentitiesSection";
import { SessionsSection } from "@/components/settings/SessionsSection";
import { WalletsSection } from "@/components/settings/WalletsSection";

const C = AUTH_COPY.settings;

/**
 * Account settings — how the person signs in, their second factors, and their signing wallets.
 *
 * Self-service only: every route acts on the caller's own account, and the server re-decides the
 * level each step needs. An action that ends this session (removing the factor it proved with,
 * unlinking the identity it signed in with, disabling a wallet) signs the browser out too.
 *
 * Sessions lists where the account is signed in; another one can be ended there, and this one
 * ends by signing out.
 */
export default function AccountSettingsPage() {
  const { session, signOut, refresh } = useSession();
  const router = useRouter();
  const [methods, setMethods] = useState<AuthMethods | null>(null);
  const [sessionsKey, setSessionsKey] = useState(0);

  useEffect(() => {
    getAuthMethods()
      .then(setMethods)
      .catch(() => setMethods(null));
  }, []);

  // An action in one section can end other sessions or change this one (a step-up, a removed
  // factor): the session list and the header's session facts are read again.
  const accountChanged = useCallback(() => {
    setSessionsKey((key) => key + 1);
    void refresh();
  }, [refresh]);

  const sessionEnded = () => {
    void signOut().then(() => router.push("/connect"));
  };

  // The workspace gate already sent a signed-out visitor to sign in; draw nothing meanwhile.
  if (!isAccountSession(session)) return null;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{C.heading}</h1>
          <p className="sub">{C.lead}</p>
        </div>
      </div>
      <FactorsSection onSessionEnded={sessionEnded} onAccountChanged={accountChanged} />
      <IdentitiesSection methods={methods} onSessionEnded={sessionEnded} onAccountChanged={accountChanged} />
      <WalletsSection onSessionEnded={sessionEnded} onAccountChanged={accountChanged} />
      <SessionsSection onSignOut={sessionEnded} reloadKey={sessionsKey} />
    </>
  );
}
