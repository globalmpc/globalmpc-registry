"use client";

import { AccessRequestPanel } from "@/components/AccessRequestPanel";

/**
 * Route that an `ASSURANCE_LEVEL_INSUFFICIENT` rejection points to
 * (`packages/api-contract/src/authorization.ts`).
 */
export default function IdentityUpgradePage() {
  return <AccessRequestPanel kind="assurance" />;
}
