import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "./api";
import type { LeanStatus } from "./types";

export interface LeanProgress {
  step: string;
  /** The latest line of output from the tool doing the work. */
  line: string;
}

/** Lean and Mathlib on this computer: whether they're ready, and setting them up. */
export function useLean() {
  const [status, setStatus] = useState<LeanStatus | null>(null);
  const [progress, setProgress] = useState<LeanProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => api.leanStatus().then(setStatus, console.error), []);
  useEffect(() => void refresh(), [refresh]);

  const setUp = useCallback(async () => {
    setError(null);
    setProgress({ step: "Starting…", line: "" });
    try {
      setStatus(
        await api.leanSetup((event) =>
          setProgress((p) =>
            event.type === "step" ? { step: event.text, line: "" } : { step: p?.step ?? "", line: event.text },
          ),
        ),
      );
    } catch (err) {
      setError(errorMessage(err));
      void refresh();
    } finally {
      setProgress(null);
    }
  }, [refresh]);

  const cancel = useCallback(() => void api.leanCancelSetup(), []);

  return { status, progress, error, refresh, setUp, cancel };
}

export type LeanApi = ReturnType<typeof useLean>;
