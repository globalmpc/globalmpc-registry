"use client";

import { AccessRequestPanel } from "@/components/AccessRequestPanel";

/**
 * `ASSURANCE_LEVEL_INSUFFICIENT` 거절이 가리키는 경로
 * (`packages/api-contract/src/authorization.ts`).
 */
export default function IdentityUpgradePage() {
  return <AccessRequestPanel kind="assurance" />;
}
