export function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

// A file's size: 812 B, 2.0 KB, 3.4 MB.
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Text's size as the server counts it.
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// "3d ago", "2h ago", "just now" — for sidebar recency labels.
export function formatRelative(ts: number, now = Date.now()): string {
  const delta = Math.max(0, now - ts);
  const mins = Math.floor(delta / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

// 84_000 → "84k", 1_200_000 → "1.2M".
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

// 4200 → "4.2s", 45000 → "45s", 65000 → "1m 5s", 3_900_000 → "1h 5m".
export function formatDuration(ms: number): string {
  // Rounded first, or 59.96 s would read "60s".
  const secs = Math.round(ms / 100) / 10;
  if (secs < 60) return `${secs.toFixed(1).replace(/\.0$/, "")}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${Math.floor(secs % 60)}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

// A tool call's or task's run: a quick one in milliseconds, not "0s".
export function formatRunTime(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : formatDuration(ms);
}

export { shortModel } from "./workspace/models";
