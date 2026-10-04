import Link from "next/link";
import { formatDate } from "@/lib/store";
import type { Flag, FlagCategory, Severity } from "@/lib/types";

const SEV_LABEL: Record<Severity, string> = { high: "High", medium: "Medium", low: "Low" };

export const CATEGORY_LABEL: Record<FlagCategory, string> = {
  compliance: "Consent limit",
  integrity: "Data quality",
  // Covers missing entries, doubtful dates, duplicates and late digitising.
  completeness: "Record keeping",
  plausibility: "Plausibility",
};

// Pattern flags (digit preference, a flat stretch) can cover a hundred
// entries; a link naming every one would be too long to be a link.
const MAX_LINKED_ENTRIES = 40;

// Where a flag's entries can be seen: /log?flag=<flag id>&entry=<id>, with
// entry repeated once per affected entry. The flag id lets the Log name the
// flag even when another flag points at exactly the same entries. null when
// the flag names no entries (a missing shift has nothing to point at).
export function logLink(entryIds: string[] | undefined | null, flagId?: string): { href: string; total: number; linked: number } | null {
  const ids = [...new Set((entryIds ?? []).filter((id) => typeof id === "string" && id !== ""))];
  if (ids.length === 0) return null;
  const linked = ids.slice(0, MAX_LINKED_ENTRIES);
  return {
    href: `/log?${typeof flagId === "string" && flagId !== "" ? `flag=${encodeURIComponent(flagId.slice(0, 200))}&` : ""}${linked.map((id) => `entry=${encodeURIComponent(id)}`).join("&")}`,
    total: ids.length,
    linked: linked.length,
  };
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  // An unknown severity is drawn as the mildest one rather than not at all.
  const sev: Severity = severity === "high" || severity === "medium" ? severity : "low";
  return (
    <span className={`sev ${sev}`}>
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
        {sev === "high" ? (
          <path d="M6 1l5.2 9.5H.8z" fill="currentColor" />
        ) : sev === "medium" ? (
          <rect x="2" y="2" width="8" height="8" rx="1.5" transform="rotate(45 6 6)" fill="currentColor" />
        ) : (
          <circle cx="6" cy="6" r="3.6" fill="currentColor" />
        )}
      </svg>
      {SEV_LABEL[sev]}
    </span>
  );
}

export function FlagList({ flags, limit }: { flags: Flag[]; limit?: number }) {
  const all = Array.isArray(flags) ? flags : [];
  const shown = limit && limit > 0 ? all.slice(0, limit) : all;
  if (shown.length === 0) return <p className="muted">Nothing to verify in this view.</p>;
  return (
    <div>
      {shown.map((f, i) => {
        const link = logLink(f.entryIds, f.id);
        return (
          <div className="flag" key={f.id || i}>
            <div className="flag-top">
              <div className="flag-what">
                <SeverityBadge severity={f.severity} />
                <span className="flag-title">{f.title || "Check this reading"}</span>
              </div>
              {/* One unit: on a phone it always takes its own line, left-aligned. */}
              <div className="flag-meta">
                <span className="tag">{CATEGORY_LABEL[f.category] ?? "Check"}</span>
                {f.date && <span className="small" style={{ color: "var(--ink-2)" }}>{formatDate(f.date)}</span>}
              </div>
            </div>
            {f.detail && <p className="flag-detail">{f.detail}</p>}
            {f.verify && <p className="flag-verify"><b>Verify:</b> {f.verify}</p>}
            {link && (
              <p className="flag-link small">
                <Link href={link.href}>
                  {link.total === 1
                    ? "Show the entry in the log"
                    : link.linked < link.total
                      ? `Show the first ${link.linked} of the ${link.total} entries in the log`
                      : `Show the ${link.total} entries in the log`}
                </Link>
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
