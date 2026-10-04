"use client";

import Link from "next/link";
import { useEffect } from "react";
import { downloadJson } from "@/components/TopBar";
import { useStore } from "@/lib/store";

// Shown in place of a screen that threw while drawing. The saved record is
// not touched by this: it lives in the browser's storage, not in the screen.
export default function ScreenError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { plant, entries, pages } = useStore();

  useEffect(() => {
    console.error("screen failed", error);
  }, [error]);

  return (
    <div className="card" role="alert">
      <h1>This screen could not be shown</h1>
      <p style={{ color: "var(--ink-2)", margin: "6px 0 14px", maxWidth: "62ch" }}>
        Something went wrong while drawing it. Your saved readings are still in this browser
        {entries.length > 0 && ` (${entries.length} ${entries.length === 1 ? "entry" : "entries"})`}. Try the screen
        again, or reload the app. To keep a copy outside the browser, use &ldquo;Download a full copy&rdquo; on the Plant screen.
      </p>
      <div className="row">
        <button className="btn primary" onClick={reset}>Try again</button>
        <button className="btn" onClick={() => window.location.reload()}>Reload</button>
        <Link className="btn" href="/log">Go to the Log screen</Link>
      </div>
      {(plant || entries.length > 0) && (
        <p className="small" style={{ color: "var(--ink-2)", marginTop: 14 }}>
          If the Log screen does not open either:{" "}
          <button
            className="linkish"
            onClick={() => downloadJson("jallog-backup.json", { savedFrom: "JalLog", plant, entries, pages })}
          >
            download a backup copy of everything (JSON)
          </button>
          . It holds the plant and every entry, without the page photos, and can be loaded back in with &ldquo;Restore from a copy&rdquo; on the Plant screen.
        </p>
      )}
      {error?.digest && <p className="muted small" style={{ marginTop: 10 }}>Error reference: {error.digest}</p>}
    </div>
  );
}
