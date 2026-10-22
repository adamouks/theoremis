import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorMessage } from "../lib/api";
import { initials } from "../lib/text";
import { CHATGPT_USAGE_URL, type ChatGptSession } from "../lib/types";
import { ArrowUpRight, OpenAILogo } from "./Icons";

interface Props {
  session: ChatGptSession | null;
  onChange: (session: ChatGptSession) => void;
}

const CANCELLED = "Sign-in was cancelled.";

/** Sign in with ChatGPT: connect the person's ChatGPT plan to the collaborator. */
export function ChatGptAccount({ session, onChange }: Props) {
  const [waiting, setWaiting] = useState(session?.status === "signingIn");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signIn = async (fresh: boolean) => {
    setError(null);
    setWaiting(true);
    try {
      onChange(await api.chatgptSignIn(fresh));
    } catch (err) {
      const message = errorMessage(err);
      if (message !== CANCELLED) setError(message);
      api.chatgptSession().then(onChange, console.error);
    } finally {
      setWaiting(false);
    }
  };

  const signOut = async () => {
    setError(null);
    setBusy(true);
    try {
      onChange(await api.chatgptSignOut());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const notice = error ?? session?.notice ?? null;
  const status = waiting ? "signingIn" : session?.status ?? "signedOut";
  const who = session?.name ?? session?.email ?? "ChatGPT account";

  return (
    <div className="account">
      {status === "connected" && session ? (
        <>
          <div className="account__row">
            <span className="avatar">{initials(who)}</span>
            <span className="account__who">
              <strong>{who}</strong>
              {session.name && session.email && <small>{session.email}</small>}
            </span>
            <span className="account__state">
              <span className="dot dot--on" />
              Connected
            </span>
          </div>
          <p className="account__note">
            {session.sharing
              ? "The collaborator runs on your ChatGPT plan, so replies count toward its usage limits."
              : "Plan usage wasn't granted, so ChatGPT models can't run here. Sign out and sign in again to allow it."}
          </p>
          <div className="account__actions">
            <button type="button" className="button button--ghost button--small" onClick={() => void openUrl(CHATGPT_USAGE_URL)}>
              Manage usage
              <ArrowUpRight size={10} />
            </button>
            <button type="button" className="text-button" onClick={signOut} disabled={busy}>
              {busy ? "Signing out…" : "Sign out"}
            </button>
          </div>
        </>
      ) : status === "signingIn" ? (
        <>
          <p className="account__note">
            Finish signing in on the page that opened in your browser, then come back here.
          </p>
          <div className="account__actions">
            <span className="account__waiting">
              <span className="spinner" aria-hidden="true" />
              Waiting for ChatGPT…
            </span>
            <button type="button" className="text-button" onClick={() => void api.chatgptCancelSignIn()}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="account__note">
            {status === "expired"
              ? "Your ChatGPT session has expired. Sign in again to keep using your plan."
              : "Use your ChatGPT plan, such as Plus or Pro, to run the collaborator. You sign in on OpenAI’s site; Theoremis never sees your password and keeps the sign-in encrypted with your system keychain."}
          </p>
          <div className="account__actions">
            <button type="button" className="button chatgpt-button" onClick={() => void signIn(false)}>
              <OpenAILogo size={15} />
              Sign in with ChatGPT
            </button>
          </div>
          {session?.email && (
            <small className="account__hint">
              Last connected as {session.email}.{" "}
              <button type="button" className="link-button" onClick={() => void signIn(true)}>
                Use a different account
              </button>
            </small>
          )}
        </>
      )}
      {notice && (
        <p className="account__notice" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}
