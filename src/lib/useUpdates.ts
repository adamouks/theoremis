import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { errorMessage } from "./api";

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "upToDate" }
  | { kind: "downloading"; version: string; percent: number | null }
  | { kind: "ready"; version: string }
  | { kind: "installing"; version: string }
  | { kind: "error"; message: string };

const FIRST_CHECK_DELAY = 10_000;
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;

/**
 * Keeps the app up to date with the latest GitHub release: checks shortly after launch and
 * every few hours, downloads new versions in the background, and installs on request.
 * `beforeRestart` runs first so nothing unsaved is lost.
 */
export function useUpdates(beforeRestart: () => Promise<unknown>) {
  const [version, setVersion] = useState<string | null>(null);
  const [status, setStatus] = useState<UpdateStatus>({ kind: "idle" });
  const downloaded = useRef<Update | null>(null);
  const busy = useRef(false);

  const run = useCallback(async (manual: boolean) => {
    if (busy.current || downloaded.current) return;
    busy.current = true;
    if (manual) setStatus({ kind: "checking" });
    try {
      const update = await check();
      if (!update) {
        setStatus({ kind: "upToDate" });
        return;
      }
      let total = 0;
      let received = 0;
      let shown = -1;
      setStatus({ kind: "downloading", version: update.version, percent: null });
      await update.download((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? 0;
        if (event.event !== "Progress" || total === 0) return;
        received += event.data.chunkLength;
        const percent = Math.min(100, Math.floor((received / total) * 100));
        if (percent !== shown) {
          shown = percent;
          setStatus({ kind: "downloading", version: update.version, percent });
        }
      });
      downloaded.current = update;
      setStatus({ kind: "ready", version: update.version });
    } catch (err) {
      // Background checks stay quiet (offline, or no release yet); a manual check says why.
      setStatus(manual ? { kind: "error", message: errorMessage(err) } : { kind: "idle" });
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    getVersion().then(setVersion, console.error);
    // Development builds aren't released, so there's nothing to update them to.
    if (import.meta.env.DEV) return;
    const first = window.setTimeout(() => void run(false), FIRST_CHECK_DELAY);
    const every = window.setInterval(() => void run(false), CHECK_INTERVAL);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(every);
    };
  }, [run]);

  const restart = useCallback(async () => {
    const update = downloaded.current;
    if (!update) return;
    setStatus({ kind: "installing", version: update.version });
    try {
      await beforeRestart();
      // On Windows the installer takes over here and reopens the app itself.
      await update.install();
      await relaunch();
    } catch (err) {
      setStatus({ kind: "error", message: errorMessage(err) });
    }
  }, [beforeRestart]);

  const checkNow = useCallback(() => run(true), [run]);

  return { version, status, checkNow, restart };
}

export type Updates = ReturnType<typeof useUpdates>;
