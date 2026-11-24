import { expect, expectTypeOf, it } from "vitest";
import {
  QUOTA_STALE_AFTER,
  type QuotaRow,
  type QuotaSnapshot,
  type QuotaState,
} from "../../shared/quota";
import type {
  QuotaSnapshot as ServiceQuotaSnapshot,
  QuotaState as ServiceQuotaState,
} from "../../service/src/session/quota-schema";
import {
  isQuotaStale,
  quotaRowLabels,
  quotaTone,
  selectSummaryWindows,
} from "../src/sidebar/quota";

it("matches the standalone service wire types without a browser runtime dependency", () => {
  expectTypeOf<QuotaSnapshot>().toEqualTypeOf<ServiceQuotaSnapshot>();
  expectTypeOf<QuotaState>().toEqualTypeOf<ServiceQuotaState>();
});

it.each([
  [49, "normal"],
  [50, "warn"],
  [79, "warn"],
  [80, "danger"],
] as const)("uses shared emphasis thresholds at %i%%", (pct, expected) =>
  expect(quotaTone(pct)).toBe(expected),
);

it("marks only observed, available rows stale at the exact boundary", () => {
  const row: QuotaRow = {
    provider: "native-codex",
    name: "Codex",
    observedAt: 1000,
    availability: "available",
    windows: [{ label: "week", usedPct: 10 }],
  };
  const now = row.observedAt + QUOTA_STALE_AFTER;
  expect(isQuotaStale(row, now - 1)).toBe(false);
  expect(isQuotaStale(row, now)).toBe(true);
  expect(isQuotaStale({ ...row, availability: "unavailable" }, now)).toBe(false);
  expect(isQuotaStale({ ...row, observedAt: 0 }, now)).toBe(false);
  expect(quotaRowLabels([row, { ...row, provider: "openai-codex" }])).toEqual([
    "Codex · native",
    "Codex · Pi",
  ]);
});

it("takes the two highest-usage windows without reordering equal windows or mutating the input", () => {
  const windows = [20, 80, 80, 50].map((usedPct, i) => ({ usedPct, label: String(i) }));
  expect(selectSummaryWindows(windows)).toEqual([windows[1], windows[2]]);
  expect(windows.map((w) => w.usedPct)).toEqual([20, 80, 80, 50]);
});
