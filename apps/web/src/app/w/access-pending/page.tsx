"use client";

import Link from "next/link";
import { accessPending, rolesAllInactive } from "@/lib/access";
import { useSession } from "@/lib/session";
import { AccessPending } from "@/components/AccessPending";

/**
 * Where a signed-in person without a usable role lands (plan §4 journey 1). A person whose roles
 * are in effect who reaches it (an old bookmark, a grant that just landed) is sent on.
 */
export default function AccessPendingPage() {
  const { session } = useSession();
  if (accessPending(session) || rolesAllInactive(session)) return <AccessPending />;
  return (
    <div className="panel" data-testid="access-granted">
      <h1>Your access is in effect</h1>
      <p className="sub">
        <Link href="/w/projects">Open the projects →</Link>
      </p>
    </div>
  );
}
