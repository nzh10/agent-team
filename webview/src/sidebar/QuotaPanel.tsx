import { useEffect, useId, useState } from "react";
import type { QuotaState } from "../../../shared/quota";
import { formatRelative } from "../format";
import {
  detailWindowLabel,
  formatShortDateTime,
  isQuotaStale,
  quotaRowLabels,
  quotaTone,
  quotaWaitingHint,
  selectSummaryWindows,
  shortWindowLabel,
} from "./quota";

export function QuotaPanel({
  quota,
  now,
  refresh,
  connected,
}: {
  quota: QuotaState;
  now: number;
  refresh?: (force?: boolean, providers?: readonly string[]) => void;
  connected: boolean;
}) {
  const panelId = useId();
  const [clock, setClock] = useState(now);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const displayTime = Math.max(now, clock);
  const labels = quotaRowLabels(quota.rows);
  const toggleRow = (key: string, provider: string) => {
    const opening = !expanded.has(key);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
    if (opening && connected) refresh?.(false, [provider]);
  };

  return (
    <section className="quota-panel system-status-panel" aria-label="Quota used">
      <header className="quota-header">
        <span className="quota-heading">Quota used</span>
        <button
          type="button"
          className={`quota-refresh${quota.refreshing ? " refreshing" : ""}`}
          disabled={!connected || quota.refreshing}
          onClick={() => refresh?.(true)}
          aria-label={quota.refreshing ? "Refreshing…" : "Refresh"}
          title={quota.refreshing ? "Refreshing…" : "Refresh quota"}
        >
          <svg
            className="icon"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M20 4v5h-5M4 20v-5h5M5 9a7.5 7.5 0 0 1 13-2l2 2M4 15l2 2a7.5 7.5 0 0 0 13-2" />
          </svg>
        </button>
      </header>
      {quota.rows.length > 0 && (
        <div className="quota-list">
          {quota.rows.map((row, index) => {
            const key = `${row.provider}/${row.name}`;
            const open = expanded.has(key);
            const detailsId = `${panelId}-row-${index}`;
            const isUnavailable = row.availability !== "available";
            const waitingHint = isUnavailable ? quotaWaitingHint(row) : undefined;
            const isError = isUnavailable && !waitingHint;
            const needsSetup = row.reason === "waiting for ACP setup";
            const isStale = isQuotaStale(row, displayTime);
            const summaryWindows = selectSummaryWindows(row.windows);
            const statusText = needsSetup
              ? "Waiting for explicit ACP setup"
              : waitingHint
                ? (row.reason ?? waitingHint)
                : [row.availability, row.reason].filter(Boolean).join(" · ");
            const rowLabel = labels[index];
            return (
              <div
                className={`quota-group${open ? " open" : ""}${isError ? " quota-group-error" : ""}${isStale ? " quota-group-stale" : ""}`}
                key={key}
              >
                <button
                  type="button"
                  className="quota-row-toggle"
                  aria-expanded={open}
                  aria-controls={detailsId}
                  onClick={() => toggleRow(key, row.provider)}
                  title={isUnavailable ? `${rowLabel} — ${statusText}` : rowLabel}
                >
                  <span className="quota-caret" aria-hidden="true">
                    {open ? "▾" : "▸"}
                  </span>{" "}
                  <span className="quota-name">{rowLabel}</span>{" "}
                  <span className="quota-summary">
                    {waitingHint && <span className="quota-detail-meta">{waitingHint}</span>}
                    {isError && (
                      <span className="quota-status-error" title={statusText}>
                        <span
                          role="img"
                          className="quota-badge quota-badge-error"
                          aria-label={statusText}
                        >
                          !
                        </span>
                        {!row.windows.length && (row.reason ?? row.availability)}
                      </span>
                    )}
                    {isStale && <span className="quota-badge quota-badge-stale">stale</span>}
                    {summaryWindows.map((w, wi) => {
                      const pct = Math.round(w.usedPct);
                      return (
                        <span className="quota-metric" key={w.label}>
                          {wi > 0 && (
                            <span className="quota-sep" aria-hidden="true">
                              ·
                            </span>
                          )}
                          <span className="quota-win-label">{shortWindowLabel(w.label)}</span>{" "}
                          <span className={`quota-pct quota-pct-${quotaTone(pct)}`}>{pct}%</span>
                        </span>
                      );
                    })}
                  </span>
                </button>
                {open && (
                  <div id={detailsId} className="quota-details">
                    {isUnavailable && (
                      <div className={isError ? "quota-detail-status" : "quota-detail-meta"}>
                        {statusText}
                        {needsSetup && quota.acpPrepareStep && (
                          <>
                            {": "}
                            <code>{quota.acpPrepareStep}</code>
                          </>
                        )}
                      </div>
                    )}
                    {row.windows.map((w) => {
                      const pct = Math.round(w.usedPct);
                      return (
                        <div className="quota-detail-window" key={w.label}>
                          <span className="quota-detail-label">{detailWindowLabel(w.label)}:</span>{" "}
                          <span className={`quota-pct quota-pct-${quotaTone(pct)}`}>
                            {pct}% used
                          </span>
                          {w.resetsAt && (
                            <span className="quota-detail-reset">
                              {" "}
                              · Resets {formatShortDateTime(w.resetsAt)}
                            </span>
                          )}
                        </div>
                      );
                    })}
                    <div className="quota-detail-meta">
                      {row.windows.length > 0 && row.observedAt > 0
                        ? `${isStale ? "stale · " : ""}Updated ${formatRelative(row.observedAt, displayTime)}`
                        : "Not yet observed"}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
