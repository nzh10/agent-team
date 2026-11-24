import { QUOTA_STALE_AFTER, type QuotaRow, type QuotaWindow } from "../../../shared/quota";

export function quotaTone(pct: number): "danger" | "warn" | "normal" {
  if (pct >= 80) return "danger";
  if (pct >= 50) return "warn";
  return "normal";
}

const PROVIDER_SHORT_LABEL: Record<string, string> = {
  "antigravity-acp": "Agy",
  "openai-codex": "Codex",
  "native-codex": "Codex",
  "kimi-coding": "Kimi",
};

function baseQuotaRowName(row: Pick<QuotaRow, "provider" | "name">): string {
  const name = row.name.trim();
  const provider = row.provider;
  const shortProvider = PROVIDER_SHORT_LABEL[provider] ?? provider;
  if (!name) return shortProvider;
  if (provider === "antigravity-acp") {
    const clean = name.replace(/^antigravity(?:[\s·:/-]+)?/i, "").trim();
    return clean ? `Agy · ${clean}` : "Agy";
  }
  if (provider === "openai-codex" || provider === "native-codex") {
    if (/^codex$/i.test(name)) return "Codex";
    const sub = name.match(/^codex[\s·:/-]+(.+)$/i);
    return sub ? `Codex · ${sub[1].trim()}` : `Codex · ${name}`;
  }
  if (provider === "kimi-coding") {
    if (/^kimi(?:\s+(?:code|coding))?$/i.test(name)) return "Kimi";
    const sub = name.match(/^kimi(?:\s+(?:code|coding))?[\s·:/-]+(.+)$/i);
    return sub ? `Kimi · ${sub[1].trim()}` : `Kimi · ${name}`;
  }
  const lowerName = name.toLowerCase();
  const lowerProvider = provider.toLowerCase();
  if (lowerName === lowerProvider || lowerName.startsWith(`${lowerProvider} `)) return name;
  return `${provider} · ${name}`;
}

export function quotaRowLabels(rows: QuotaRow[]): string[] {
  const bases = rows.map(baseQuotaRowName);
  const providersByBase = new Map<string, Set<string>>();
  for (let i = 0; i < rows.length; i++) {
    let set = providersByBase.get(bases[i]);
    if (!set) {
      set = new Set();
      providersByBase.set(bases[i], set);
    }
    set.add(rows[i].provider);
  }
  return rows.map((row, i) => {
    const base = bases[i];
    if ((providersByBase.get(base)?.size ?? 0) <= 1) return base;
    if (row.provider === "native-codex") return `${base} · native`;
    if (row.provider === "openai-codex") return `${base} · Pi`;
    return `${base} · ${row.provider}`;
  });
}

export function shortWindowLabel(label: string): string {
  const trimmed = label.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "weekly" || lower === "week" || lower === "7d") return "wk";
  if (lower === "daily" || lower === "day" || lower === "1d") return "1d";
  if (lower === "monthly" || lower === "month" || lower === "30d" || lower === "monthly total")
    return "mo";
  if (lower === "monthly code") return "code";
  if (lower === "primary") return "1st";
  if (lower === "secondary") return "2nd";
  return trimmed;
}

export function detailWindowLabel(label: string): string {
  const trimmed = label.trim();
  if (/^[a-z]/.test(trimmed)) return trimmed[0].toUpperCase() + trimmed.slice(1);
  return trimmed;
}

export function selectSummaryWindows(windows: QuotaWindow[]): QuotaWindow[] {
  if (windows.length <= 2) return windows;
  return windows
    .map((w, i) => ({ w, i }))
    .sort((a, b) => b.w.usedPct - a.w.usedPct || a.i - b.i)
    .slice(0, 2)
    .map((entry) => entry.w);
}

export function formatShortDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function quotaWaitingHint(row: QuotaRow): string | undefined {
  switch (row.reason) {
    case "not configured":
      return "not configured";
    case "waiting for ACP setup":
      return "waiting for setup";
    case "waiting for Pi session":
    case "checking usage":
      return "warming up";
    default:
      return row.observedAt === 0 && !row.reason ? "warming up" : undefined;
  }
}

export function isQuotaStale(row: QuotaRow, now: number): boolean {
  return (
    row.availability === "available" &&
    row.windows.length > 0 &&
    row.observedAt > 0 &&
    now - row.observedAt >= QUOTA_STALE_AFTER
  );
}
