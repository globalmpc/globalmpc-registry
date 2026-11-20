"use client";

import { useCallback, useState } from "react";
import { authErrorMessage } from "@/lib/auth-errors";

/**
 * One settings action at a time, with step-up: a refusal for the session's level prompts for the
 * factor and retries once (`StepUp`); any other refusal becomes one sentence on screen. Closing the
 * prompt is not an error.
 */
export function useAction(onChanged: () => Promise<void> | void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
      setBusy(true);
      setError(null);
      try {
        const result = await action();
        await onChanged();
        return result;
      } catch (caught) {
        setError(authErrorMessage(caught));
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  return { act, busy, error };
}

export function ErrorLine({ error }: { readonly error: string | null }) {
  return error ? (
    <div className="notice" style={{ color: "var(--destructive-text)" }} role="alert">
      {error}
    </div>
  ) : null;
}
