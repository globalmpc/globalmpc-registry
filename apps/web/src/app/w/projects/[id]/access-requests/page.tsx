"use client";

import { use } from "react";
import { AccessRequestPanel } from "@/components/AccessRequestPanel";

/**
 * `ROLE_ACTION_NOT_ALLOWED`·`PROJECT_SCOPE_MISMATCH` 거절이 프로젝트 범위에서
 * 가리키는 경로(`packages/api-contract/src/authorization.ts`).
 */
export default function ProjectAccessRequestsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return <AccessRequestPanel kind="project" projectId={id} />;
}
