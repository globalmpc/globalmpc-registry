import type { ReactNode } from "react";
import { truncationText } from "@/lib/lists";

/**
 * Says a list is not complete.
 *
 * Rendered only when the server reported `truncated`. Without it a capped list reads as
 * "that is everything", and the missing rows are never looked for.
 */
export function TruncatedNotice({
  shown,
  total,
  noun,
  testId,
  children,
}: {
  shown: number;
  total?: number;
  noun: string;
  testId: string;
  children?: ReactNode;
}) {
  return (
    <div className="notice" style={{ color: "var(--alert)" }} role="status" data-testid={testId}>
      {truncationText({ shown, total, noun })}
      {children ? <div style={{ marginTop: 6 }}>{children}</div> : null}
    </div>
  );
}
