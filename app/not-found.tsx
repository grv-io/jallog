import Link from "next/link";

export default function NotFound() {
  return (
    <div className="card">
      <h1>There is no page at this address</h1>
      <p style={{ color: "var(--ink-2)", margin: "6px 0 14px" }}>
        The link may be mistyped or out of date. Your saved readings are not affected.
      </p>
      <div className="row">
        <Link className="btn primary" href="/">Go to the overview</Link>
        <Link className="btn" href="/capture">Add a logbook page</Link>
        <Link className="btn" href="/log">Open the log</Link>
      </div>
    </div>
  );
}
