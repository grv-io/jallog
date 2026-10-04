"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useStore } from "@/lib/store";

const ICONS: Record<string, React.ReactNode> = {
  overview: <path d="M3 12l9-8 9 8M5 10v10h14V10" />,
  capture: (
    <>
      <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
  log: <path d="M4 5h16M4 10h16M4 15h16M4 20h10" />,
  flags: <path d="M5 21V4m0 1h12l-2.5 4L17 13H5" />,
  report: <path d="M7 3h8l4 4v14H7zM14 3v5h5M10 13h6M10 17h6" />,
  plant: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10l2 2M19 5l-2 2M7 17l-2 2" />
    </>
  ),
};

const ITEMS = [
  { href: "/", key: "overview", label: "Overview" },
  { href: "/capture", key: "capture", label: "Capture" },
  { href: "/log", key: "log", label: "Log" },
  { href: "/flags", key: "flags", label: "Flags" },
  { href: "/report", key: "report", label: "Report" },
  { href: "/plant", key: "plant", label: "Plant" },
];

const APP_TITLE = "JalLog – paper plant logbooks, read and checked";

// The screens are client components, which cannot export Next metadata, so
// without this every screen had the same title: browser tabs, history, the
// phone's task switcher and screen readers could not tell them apart.
export function screenTitle(path: string | null | undefined): string {
  if (!path || path === "/") return APP_TITLE;
  const item = ITEMS.find((it) => it.href !== "/" && (path === it.href || path.startsWith(`${it.href}/`)));
  return item ? `${item.label} – JalLog` : "Page not found – JalLog";
}

function Icon({ name }: { name: string }) {
  return (
    <svg
      className="ico" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden
    >
      {ICONS[name]}
    </svg>
  );
}

// The cross on "close" and "remove" buttons. Drawn, not typed: the ✕ character
// comes out in a different colour and weight from one font to the next.
export function Cross() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
      <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
    </svg>
  );
}

// An in-page "are you sure". Used instead of window.confirm, which some
// in-app browsers suppress and which cannot say what will be lost. Focus
// starts on the safe answer.
export function Confirm({
  text, yes, no, onYes, onNo, danger = false,
}: {
  text: string;
  yes: string;
  no: string;
  onYes: () => void;
  onNo: () => void;
  danger?: boolean;
}) {
  return (
    <div className="confirm" role="group" aria-label="Please confirm">
      <p>{text}</p>
      <div className="row">
        <button type="button" className="btn sm" onClick={onNo} autoFocus>{no}</button>
        <button type="button" className={`btn sm ${danger ? "danger" : "primary"}`} onClick={onYes}>{yes}</button>
      </div>
    </div>
  );
}

// Hands the user a file made in the browser. Nothing is uploaded.
export function downloadText(fileName: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadJson(fileName: string, value: unknown) {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  downloadText(fileName, text, "application/json");
}

export function TopBar() {
  const path = usePathname();
  const {
    plant, checks, storageError, storageErrorIsSave, storageErrorCanRetry, recovery, retrySave, dismissStorageError, dismissRecovery, reset,
  } = useStore();
  const [confirmFresh, setConfirmFresh] = useState(false);
  const high = checks?.flags.filter((f) => f.severity === "high").length ?? 0;

  // Set after every navigation; the layout's metadata gives the title only for the first paint.
  useEffect(() => {
    document.title = screenTitle(path);
  }, [path]);

  // While the browser is refusing to store changes they exist in this tab
  // only, and closing it would lose them without any question. Ask.
  useEffect(() => {
    if (!storageErrorIsSave) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [storageErrorIsSave]);

  return (
    <>
      <header className="topbar">
        <div className="topbar-in">
          <Link href="/" className="brand" aria-label="JalLog home">
            <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
              <path d="M12 2.5c3.6 4.3 6.5 7.8 6.5 11.3a6.5 6.5 0 0 1-13 0c0-3.5 2.9-7 6.5-11.3z" fill="#0e5a6b" />
              <path d="M8.6 14.2l2.3 2.3 4.4-4.6" fill="none" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            JalLog
          </Link>
          <nav className="nav" aria-label="Sections">
            {ITEMS.map((it) => (
              <Link key={it.href} href={it.href} aria-current={path === it.href ? "page" : undefined}>
                <Icon name={it.key} />
                {it.label}
                {it.key === "flags" && high > 0 && (
                  <span className="count">
                    {high > 99 ? "99+" : high}
                    <span className="sr-only"> high-severity {high === 1 ? "flag" : "flags"}</span>
                  </span>
                )}
              </Link>
            ))}
          </nav>
          {plant && <span className="plant-chip" title={plant.name}>{plant.name}</span>}
        </div>
      </header>

      {storageError && (
        <div className="banner bad no-print" role="alert">
          <div className="banner-in">
            <p>{storageError}</p>
            {storageErrorIsSave ? (
              <button type="button" className="btn sm" onClick={retrySave}>Try saving again</button>
            ) : (
              <div className="row">
                {/* A photo that was refused is still held in this tab and can be stored once there is room. */}
                {storageErrorCanRetry && <button type="button" className="btn sm" onClick={retrySave}>Try again</button>}
                <button type="button" className="btn sm" onClick={dismissStorageError}>Dismiss</button>
              </div>
            )}
          </div>
        </div>
      )}

      {recovery && (
        <div className="banner warn no-print" role="alert">
          <div className="banner-in">
            {recovery.kind === "unreadable" ? (
              <p>
                The data saved in this browser could not be read, so JalLog has opened empty. Nothing has been deleted:
                the stored copy stays as it is until you start fresh or add something. Download it first if you may want it back.
              </p>
            ) : (
              <p>
                Some of the data saved in this browser was damaged.
                {recovery.dropped > 0 && ` ${recovery.dropped} ${recovery.dropped === 1 ? "item" : "items"} could not be read and ${recovery.dropped === 1 ? "is" : "are"} left out.`}{" "}
                Everything else is shown, repaired where needed. The stored copy stays as it was until your next change;
                download it first if you want to keep it.
              </p>
            )}
            {confirmFresh ? (
              <Confirm
                text="Start with an empty JalLog? The unreadable stored copy and any stored page photos will be deleted from this browser."
                no="Cancel" yes="Delete and start fresh" danger
                onNo={() => setConfirmFresh(false)}
                onYes={() => { setConfirmFresh(false); reset(); }}
              />
            ) : (
              <div className="row">
                <button type="button" className="btn sm" onClick={() => downloadJson("jallog-stored-copy.json", recovery.raw)}>Download the stored copy</button>
                {recovery.kind === "unreadable"
                  ? <button type="button" className="btn sm" onClick={() => setConfirmFresh(true)}>Start fresh</button>
                  : <button type="button" className="btn sm" onClick={dismissRecovery}>Continue with what was read</button>}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
