"use client";

import { use } from "react";
import { AccessRequestPanel } from "@/components/AccessRequestPanel";

/**
 * Route that `ROLE_ACTION_NOT_ALLOWED`/`PROJECT_SCOPE_MISMATCH` rejections point to within project
 * scope (`packages/api-contract/src/authorization.ts`).
 */
export default function ProjectAccessRequestsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return <AccessRequestPanel kind="project" projectId={id} />;
}
