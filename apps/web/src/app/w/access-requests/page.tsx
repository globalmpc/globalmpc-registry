"use client";

import { AccessRequestPanel } from "@/components/AccessRequestPanel";

/**
 * `ROLE_ACTION_NOT_ALLOWED` 거절이 프로젝트 범위 밖에서 가리키는 경로
 * (`packages/api-contract/src/authorization.ts`).
 */
export default function AccessRequestsPage() {
  return <AccessRequestPanel kind="role" />;
}
