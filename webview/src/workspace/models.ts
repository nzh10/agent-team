import type { CodexAuthState, ModelOption } from "../state/useServer";

export const CODEX_SETUP_VALUE = "__codex_setup__";

export function isCodexSetup(value: string): boolean {
  return value === CODEX_SETUP_VALUE;
}

export function needsCodexSetup(auth?: CodexAuthState | null): boolean {
  return !!auth?.cliAvailable && !auth.authenticated;
}

export function usableModels(models: ModelOption[], auth?: CodexAuthState | null): ModelOption[] {
  return auth && !auth.authenticated ? models.filter((m) => m.backend !== "codex") : models;
}

export function parseModelId(id: string) {
  const suffix = id.match(/\[1m\]$/i)?.[0] ?? "";
  const raw = suffix ? id.slice(0, -suffix.length) : id;
  const slash = raw.lastIndexOf("/");
  const provider = slash < 0 ? "" : raw.slice(0, slash);
  const name = raw.slice(slash + 1);
  const date = name.match(/-(\d{8})$/)?.[1] ?? "";
  const base = (date ? name.slice(0, -date.length - 1) : name)
    .replace(/^claude-/, "")
    .replace(/-(\d+)-(\d+)(?=-|$)/, " $1.$2")
    .replace(/-/g, " ");
  return { id, provider, date, short: suffix ? `${base} ${suffix}` : base };
}

export function shortModel(id: string): string {
  return parseModelId(id).short;
}

// Keep full IDs as select values; only add provider and snapshot date to labels
// when needed to distinguish otherwise identical short names.
export function modelLabels(ids: string[]): Array<{ id: string; label: string }> {
  const parsed = ids.map(parseModelId);
  const groups = new Map<string, { providers: Set<string>; dates: Set<string>; count: number }>();
  for (const item of parsed) {
    let group = groups.get(item.short);
    if (!group)
      groups.set(item.short, (group = { providers: new Set(), dates: new Set(), count: 0 }));
    group.providers.add(item.provider);
    group.dates.add(item.date);
    group.count++;
  }
  const counts = new Map<string, number>();
  const labels = parsed.map(({ id, short, provider, date }) => {
    const group = groups.get(short)!;
    const detail =
      group.count > 1
        ? [group.providers.size > 1 && provider, group.dates.size > 1 && date]
            .filter(Boolean)
            .join(", ")
        : "";
    const label = detail ? `${short} (${detail})` : short;
    counts.set(label, (counts.get(label) ?? 0) + 1);
    return { id, label };
  });
  return labels.map(({ id, label }) => ({ id, label: counts.get(label)! > 1 ? id : label }));
}
