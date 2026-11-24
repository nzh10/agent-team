// Browser wire contract mirrors service/src/session/quota-schema.ts. The
// service's standalone Pi extension keeps its own runtime schema for jiti.
export const QUOTA_STALE_AFTER = 15 * 60_000;

export interface QuotaWindow {
  label: string;
  usedPct: number;
  resetsAt?: number;
}

export interface QuotaGroup {
  name: string;
  windows: QuotaWindow[];
}

export interface QuotaSnapshot {
  provider: string;
  observedAt: number;
  availability: "available" | "unavailable" | "unsupported";
  reason?:
    | "not configured"
    | "waiting for ACP setup"
    | "waiting for Pi session"
    | "checking usage"
    | "usage unavailable"
    | "no quota adapter";
  groups: QuotaGroup[];
}

export interface QuotaRow {
  provider: string;
  name: string;
  observedAt: number;
  availability: QuotaSnapshot["availability"];
  reason?: QuotaSnapshot["reason"];
  windows: QuotaWindow[];
}

export interface QuotaState {
  acpPrepareStep?: string;
  refreshing: boolean;
  rows: QuotaRow[];
}
