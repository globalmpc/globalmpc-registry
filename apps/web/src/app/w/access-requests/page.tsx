"use client";

import { AccessRequestPanel } from "@/components/AccessRequestPanel";

/**
 * Route that a `ROLE_ACTION_NOT_ALLOWED` rejection points to outside project scope
 * (`packages/api-contract/src/authorization.ts`).
 */
export default function AccessRequestsPage() {
  return <AccessRequestPanel kind="role" />;
}
