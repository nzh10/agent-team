import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionConfig } from "./types";

export type ControlledPiAgentHomeMode = "runtime" | "test-synthetic" | "test-copied-creds";

export type PiPackageEntry = string | ({ source: string } & Record<string, unknown>);

export interface LocalPiPackages {
  packages: PiPackageEntry[];
  piSubagentsRoot?: string;
  piAntigravityEntryPath?: string;
}

export interface PrepareControlledPiAgentHomeOptions {
  mode: ControlledPiAgentHomeMode;
  dataDir?: string;
  sourceAgentDir?: string;
  sourceGeminiDir?: string;
  packages?: readonly PiPackageEntry[];
  excludePackages?: readonly string[];
  offline?: boolean;
  isolateGeminiHome?: boolean;
  piAcp?: SessionConfig["piAcp"];
}

export interface ControlledPiAgentHome {
  piAgentDir: string;
  settingsPath: string;
  env: Record<string, string>;
  resolvedPackages: {
    piSubagentsRoot?: string;
    piAntigravityEntryPath?: string;
  };
  geminiHome?: string;
  piAcpProfileError?: string;
}

type SourceSettings = {
  packages?: unknown;
  enabledModels?: unknown;
  defaultProvider?: unknown;
  defaultModel?: unknown;
  subagents?: unknown;
};

function readSettings(sourceAgentDir: string): SourceSettings {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(sourceAgentDir, "settings.json"), "utf8"),
    ) as SourceSettings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function packageSource(entry: PiPackageEntry): string {
  return typeof entry === "string" ? entry : entry.source;
}

function packageName(entry: PiPackageEntry): string {
  const source = packageSource(entry);
  if (path.isAbsolute(source)) {
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(source, "package.json"), "utf8").replace(/^\uFEFF/, ""),
      ) as { name?: unknown };
      if (manifest?.name === "pi-antigravity-acp-provider") return manifest.name;
    } catch {
      // Pi also accepts local directories without a package manifest.
    }
  }
  const withoutScheme = source.startsWith("npm:") ? source.slice(4) : source;
  return path.basename(withoutScheme.replace(/[\\/]$/, ""));
}

function expandHome(entry: string): string {
  if (entry === "~") return os.homedir();
  if (entry.startsWith(`~${path.sep}`) || entry.startsWith("~/")) {
    return path.join(os.homedir(), entry.slice(2));
  }
  return entry;
}

function candidatePath(entry: string, sourceAgentDir: string): string {
  return entry.startsWith("npm:")
    ? path.join(sourceAgentDir, "npm", "node_modules", entry.slice(4))
    : path.resolve(sourceAgentDir, expandHome(entry));
}

function resolvePackageEntry(entry: PiPackageEntry, sourceAgentDir: string): PiPackageEntry {
  const source = fs.realpathSync.native(candidatePath(packageSource(entry), sourceAgentDir));
  return typeof entry === "string" ? source : { ...entry, source };
}

function isPackageEntry(entry: unknown): entry is PiPackageEntry {
  return (
    typeof entry === "string" ||
    (entry !== null &&
      typeof entry === "object" &&
      "source" in entry &&
      typeof entry.source === "string")
  );
}

function packageEntries(settings: SourceSettings): PiPackageEntry[] {
  return Array.isArray(settings.packages) ? settings.packages.filter(isPackageEntry) : [];
}

function orderPackages(packages: PiPackageEntry[]): PiPackageEntry[] {
  const uniqueBySource = new Map<string, PiPackageEntry>();
  for (const entry of packages) {
    const source = packageSource(entry);
    const existing = uniqueBySource.get(source);
    if (existing === undefined || (typeof existing === "string" && typeof entry !== "string")) {
      uniqueBySource.set(source, entry);
    }
  }
  const unique = [...uniqueBySource.values()];
  const subagents = unique.find((entry) => packageName(entry) === "pi-subagents");
  const provider = unique.find((entry) => packageName(entry) === "pi-antigravity-acp-provider");
  const ordered = unique.filter(
    (entry) =>
      packageName(entry) !== "pi-subagents" && packageName(entry) !== "pi-antigravity-acp-provider",
  );
  if (subagents) ordered.push(subagents);
  if (provider) ordered.push(provider);
  return ordered;
}

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

type GlobPart = {
  matches: (value: string) => boolean;
  star?: true;
  requiresInput?: true;
};

function matchGlobParts(input: string[], parts: GlobPart[]): boolean {
  // Keep only the previous and current rows of (pattern position, input position).
  let previous = new Uint8Array(input.length + 1);
  let current = new Uint8Array(input.length + 1);
  previous[0] = 1;
  for (const part of parts) {
    current[0] = part.star && !part.requiresInput ? previous[0] : 0;
    for (let i = 1; i <= input.length; i++) {
      current[i] = part.star
        ? Number(
            (previous[i] && (!part.requiresInput || i < input.length)) ||
              (part.matches(input[i - 1]) && (current[i - 1] || previous[i - 1])),
          )
        : Number(previous[i - 1] && part.matches(input[i - 1]));
    }
    [previous, current] = [current, previous];
  }
  return previous[input.length] === 1;
}

type GlobSegment = GlobPart & { literal?: string };
const globstar: GlobSegment = { star: true, matches: (value) => !value.startsWith(".") };

function parseCharacterClass(chars: string[], start: number, ignoreCase: boolean) {
  const negated = chars[start + 1] === "!" || chars[start + 1] === "^";
  const members: { value: string; escaped: boolean }[] = [];
  let i = start + (negated ? 2 : 1);
  for (; i < chars.length; i++) {
    if (chars[i] === "]" && members.length > 0) break;
    const escaped = chars[i] === "\\" && i + 1 < chars.length;
    members.push({ value: chars[escaped ? ++i : i], escaped });
  }
  if (i === chars.length) return undefined;
  const ranges: [string, string][] = [];
  for (let j = 0; j < members.length; j++) {
    const first = members[j].value;
    const dash = members[j + 1];
    if (dash?.value === "-" && !dash.escaped && j + 2 < members.length) {
      const last = members[j + 2].value;
      if (first <= last) ranges.push([first, last]);
      j += 2;
    } else {
      ranges.push([first, first]);
    }
  }
  const literal =
    !negated && ranges.length === 1 && ranges[0][0] === ranges[0][1] ? ranges[0][0] : undefined;
  return {
    end: i,
    literal,
    matches: (value: string) => {
      const contains = (input: string) =>
        ranges.some(([first, last]) => first <= input && input <= last);
      return (
        (contains(value) ||
          (ignoreCase && (contains(value.toLowerCase()) || contains(value.toUpperCase())))) !==
        negated
      );
    },
  };
}

function compileGlobSegment(segment: string, caseMode?: "all" | "magic"): GlobSegment {
  if (segment === "**") return globstar;
  const equals = caseMode
    ? (value: string, expected: string) => value.toLowerCase() === expected.toLowerCase()
    : (value: string, expected: string) => value === expected;
  const chars = Array.from(segment);
  const parts: GlobPart[] = [];
  let literal: string | undefined = "";
  let explicitDot = false;
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    if (char === "*" || char === "?") {
      parts.push(char === "*" ? { star: true, matches: () => true } : { matches: () => true });
      literal = undefined;
      continue;
    }
    const characterClass = char === "[" ? parseCharacterClass(chars, i, !!caseMode) : undefined;
    if (characterClass) {
      parts.push(characterClass);
      literal =
        literal !== undefined && characterClass.literal !== undefined
          ? literal + characterClass.literal
          : undefined;
      i = characterClass.end;
      continue;
    }
    const value = char === "\\" && i + 1 < chars.length ? chars[++i] : char;
    if (parts.length === 0) explicitDot = value === ".";
    if (literal !== undefined) literal += value;
    parts.push({ matches: (input) => equals(input, value) });
  }
  if (literal !== undefined) {
    const expected = literal;
    return {
      literal,
      matches: (value) => (caseMode === "all" ? equals(value, expected) : value === expected),
    };
  }
  return {
    matches: (value) =>
      value !== "" &&
      (explicitDot || !value.startsWith(".")) &&
      matchGlobParts(Array.from(value), parts),
  };
}

function compileFilterGlob(pattern: string): (value: string) => boolean {
  if (pattern.startsWith("#")) return () => false;
  let negate = false;
  while (pattern.startsWith("!")) {
    negate = !negate;
    pattern = pattern.slice(1);
  }
  if (!pattern) return (value) => (value === "") !== negate;
  const parts = pattern.split(/\/+/).map((part) => compileGlobSegment(part));
  if (parts.at(-1) === globstar && parts.some((part) => part !== globstar)) {
    parts[parts.length - 1] = { ...globstar, requiresInput: true };
  }
  return (value) => matchGlobParts(value.split(/\/+/), parts) !== negate;
}

function normalizeFilterPattern(pattern: string, exact: boolean): string {
  if (exact && (pattern.startsWith("./") || pattern.startsWith(".\\"))) {
    pattern = pattern.slice(2);
  }
  if (process.platform === "win32") {
    const drive =
      !pattern.includes("\\") && /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(pattern);
    if (drive) pattern = `${drive[1].toUpperCase()}:\\${drive[2] ?? ""}`;
    if (pattern.startsWith("~\\")) pattern = `~/${pattern.slice(2)}`;
  }
  return toPosixPath(pattern.startsWith("file://") ? fileURLToPath(pattern) : expandHome(pattern));
}

function isOverridePattern(pattern: string): boolean {
  return pattern.startsWith("!") || pattern.startsWith("+") || pattern.startsWith("-");
}

type ExtensionFilter = {
  kind: "include" | "exclude" | "forceInclude" | "forceExclude";
  matches: (filename: string) => boolean;
};

function compileExtensionFilters(patterns: string[], root: string): ExtensionFilter[] {
  return patterns.map((pattern) => {
    const prefix = pattern[0];
    const kind =
      prefix === "+"
        ? "forceInclude"
        : prefix === "-"
          ? "forceExclude"
          : prefix === "!"
            ? "exclude"
            : "include";
    const exact = kind === "forceInclude" || kind === "forceExclude";
    const target = normalizeFilterPattern(kind === "include" ? pattern : pattern.slice(1), exact);
    const matches = exact ? (value: string) => value === target : compileFilterGlob(target);
    return {
      kind,
      matches: (filename) =>
        matches(toPosixPath(path.relative(root, filename))) ||
        (!exact && matches(path.basename(filename))) ||
        matches(toPosixPath(filename)),
    };
  });
}

function applyPatterns(files: string[], filters: ExtensionFilter[]): Set<string> {
  const includes = filters.filter((filter) => filter.kind === "include");
  const excludes = filters.filter((filter) => filter.kind === "exclude");
  const forceIncludes = filters.filter((filter) => filter.kind === "forceInclude");
  const forceExcludes = filters.filter((filter) => filter.kind === "forceExclude");
  const enabled = new Set(
    files.filter(
      (file) =>
        (includes.length === 0 || includes.some(({ matches }) => matches(file))) &&
        !excludes.some(({ matches }) => matches(file)),
    ),
  );
  for (const file of files) {
    if (!enabled.has(file) && forceIncludes.some(({ matches }) => matches(file))) enabled.add(file);
  }
  for (const file of enabled) {
    if (forceExcludes.some(({ matches }) => matches(file))) enabled.delete(file);
  }
  return enabled;
}

function applyPackageDeltaFilter(files: string[], filters: ExtensionFilter[]): string[] {
  // With autoload disabled, only explicitly matched files get a state; the last rule wins.
  const enabled = new Map<string, boolean>();
  for (const { kind, matches } of filters) {
    for (const file of files) {
      if (matches(file)) enabled.set(file, kind === "include" || kind === "forceInclude");
    }
  }
  return [...enabled.keys()].filter((file) => enabled.get(file));
}

function readExtensionManifest(dir: string): { extensions?: string[]; hasResources: boolean } {
  const isStringArray = (entries: unknown): entries is string[] =>
    Array.isArray(entries) && entries.every((entry) => typeof entry === "string");
  try {
    const contents = fs.readFileSync(path.join(dir, "package.json"), "utf8").replace(/^\uFEFF/, "");
    const pkg = JSON.parse(contents) as { pi?: Record<string, unknown> } | null;
    const pi = pkg?.pi;
    if (pi && typeof pi === "object" && !Array.isArray(pi)) {
      return {
        extensions: isStringArray(pi.extensions) ? pi.extensions : undefined,
        hasResources: ["extensions", "skills", "prompts", "themes"].some((key) =>
          isStringArray(pi[key]),
        ),
      };
    }
  } catch {
    // Pi falls back to convention discovery for unreadable or malformed manifests.
  }
  return { hasResources: false };
}

function resolveExtensionEntries(dir: string): string[] | undefined {
  const declared = readExtensionManifest(dir).extensions;
  const entries = declared?.map((file) => path.resolve(dir, file)).filter(fs.existsSync);
  if (entries?.length) return entries;
  for (const name of ["index.ts", "index.js"]) {
    const index = path.join(dir, name);
    if (fs.existsSync(index)) return [index];
  }
  return undefined;
}

function readDirectory(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readStats(file: string): fs.Stats | undefined {
  try {
    return fs.statSync(file, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
}

function readExtensionIgnoreRules(dir: string) {
  // Convention discovery checks direct children only. A leading **/ can match zero directories.
  const rules: { ignored: boolean; directoryOnly: boolean; segment: GlobSegment }[] = [];
  for (const name of [".gitignore", ".ignore", ".fdignore"]) {
    let contents: string;
    try {
      contents = fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    for (let pattern of contents.split(/\r?\n/)) {
      if (!pattern.trim() || pattern.trimStart().startsWith("#")) continue;
      const ignored = !pattern.startsWith("!") && !pattern.startsWith("\\!");
      if (!ignored) pattern = pattern.slice(pattern.startsWith("\\") ? 2 : 1);
      while (pattern.endsWith(" ") && !pattern.endsWith("\\ ")) pattern = pattern.slice(0, -1);
      if (pattern.startsWith("/")) pattern = pattern.slice(1);
      const directoryOnly = pattern.endsWith("/");
      if (directoryOnly) pattern = pattern.slice(0, -1);
      while (pattern.startsWith("**/")) pattern = pattern.slice(3);
      if (pattern && !pattern.includes("/")) {
        rules.push({ ignored, directoryOnly, segment: compileGlobSegment(pattern, "all") });
      }
    }
  }
  return (name: string, isDirectory: boolean) => {
    let ignored = false;
    for (const rule of rules) {
      if ((!rule.directoryOnly || isDirectory) && rule.segment.matches(name)) {
        ignored = rule.ignored;
      }
    }
    return ignored;
  };
}

function collectAutoExtensionEntries(dir: string): string[] {
  const rootEntries = resolveExtensionEntries(dir);
  if (rootEntries) return rootEntries;
  const ignores = readExtensionIgnoreRules(dir);
  const entries: string[] = [];
  for (const entry of readDirectory(dir)) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const fullPath = path.join(dir, entry.name);
    const stats = entry.isSymbolicLink() ? readStats(fullPath) : entry;
    if (!stats || ignores(entry.name, stats.isDirectory())) continue;
    if (stats.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
      entries.push(fullPath);
    }
    if (stats.isDirectory()) entries.push(...(resolveExtensionEntries(fullPath) ?? []));
  }
  return entries;
}

function expandPackageGlob(pattern: string, root: string): string[] {
  const absoluteRoot = path.parse(pattern).root;
  // Node's package glob uses case-insensitive wildcard segments on Windows and macOS.
  const caseMode =
    process.platform === "darwin" || process.platform === "win32" ? "magic" : undefined;
  const parts: GlobSegment[] = [];
  for (const part of toPosixPath(pattern.slice(absoluteRoot.length)).split(/\/+/)) {
    const segment = compileGlobSegment(part, caseMode);
    const previous = parts.at(-1)?.literal;
    if (segment.literal === ".") continue;
    if (segment.literal === ".." && previous !== undefined && previous !== "..") parts.pop();
    else parts.push(segment);
  }
  const pending = [{ file: absoluteRoot || root, part: 0 }];
  const visited = new Map<string, Set<number>>();
  const matches = new Set<string>();
  while (pending.length > 0) {
    const { file, part } = pending.pop()!;
    const seen = visited.get(file) ?? new Set<number>();
    if (seen.has(part)) continue;
    seen.add(part);
    visited.set(file, seen);
    if (part === parts.length) {
      if (
        toPosixPath(path.relative(root, file))
          .split("/")
          .every((name) => name === ".." || !name.startsWith("."))
      )
        matches.add(file);
      continue;
    }
    const segment = parts[part];
    if (segment.literal !== undefined) {
      const next = path.resolve(file, segment.literal);
      if (segment.literal === "" ? readStats(next)?.isDirectory() : fs.existsSync(next)) {
        pending.push({ file: next, part: part + 1 });
      }
      continue;
    }
    const recursive = segment === globstar;
    if (recursive) pending.push({ file, part: part + 1 });
    for (const entry of readDirectory(file)) {
      if (!segment.matches(entry.name)) continue;
      const next = path.join(file, entry.name);
      if (recursive && entry.isDirectory()) pending.push({ file: next, part });
      else if (part + 1 === parts.length || (!recursive && entry.isDirectory())) {
        // A wildcard can select symlinks but cannot recursively descend through them.
        pending.push({ file: next, part: part + 1 });
      }
    }
  }
  return [...matches].sort();
}

function collectManifestFiles(
  entries: string[],
  root: string,
): { files: string[]; enabled: Set<string> } {
  const files = new Set<string>();
  for (const entry of entries) {
    if (isOverridePattern(entry)) continue;
    const paths =
      entry.includes("*") || entry.includes("?")
        ? expandPackageGlob(entry, root)
        : [path.resolve(root, entry)];
    for (const file of paths) {
      const stats = readStats(file);
      if (stats?.isFile()) files.add(file);
      else if (stats?.isDirectory()) {
        for (const extension of collectAutoExtensionEntries(file)) files.add(extension);
      }
    }
  }
  const allFiles = [...files];
  return {
    files: allFiles,
    enabled: applyPatterns(
      allFiles,
      compileExtensionFilters(entries.filter(isOverridePattern), root),
    ),
  };
}

function resolvePackageExtensions(entry: PiPackageEntry): string[] {
  const root = packageSource(entry);
  const delta = typeof entry !== "string" && entry.autoload === false;
  const patterns =
    typeof entry !== "string" && Array.isArray(entry.extensions)
      ? entry.extensions.filter((item): item is string => typeof item === "string")
      : undefined;
  if ((delta || patterns !== undefined) && !patterns?.length) return [];

  const manifest = readExtensionManifest(root);
  const convention = () => collectAutoExtensionEntries(path.join(root, "extensions"));
  if (!patterns) {
    // An empty declaration disables defaults, but explicit user filters below can
    // select convention entries when there are no manifest sources.
    if (manifest.extensions) {
      const { files, enabled } = collectManifestFiles(manifest.extensions, root);
      return files.filter((file) => enabled.has(file));
    }
    return typeof entry === "string" && manifest.hasResources ? [] : convention();
  }

  const files = manifest.extensions?.length
    ? [...collectManifestFiles(manifest.extensions, root).enabled]
    : convention();
  const filters = compileExtensionFilters(patterns, root);
  if (delta) return applyPackageDeltaFilter(files, filters);
  const enabled = applyPatterns(files, filters);
  return files.filter((file) => enabled.has(file));
}

function resolveLocalPiPackages(
  entries: readonly PiPackageEntry[],
  sourceAgentDir: string,
  excludePackages: readonly string[] = [],
): LocalPiPackages {
  const excluded = new Set(excludePackages.map(packageName));
  const isIncluded = (entry: PiPackageEntry) => !excluded.has(packageName(entry));
  const packages = orderPackages(
    entries
      .filter(isIncluded)
      .map((entry) => resolvePackageEntry(entry, sourceAgentDir))
      .filter(isIncluded),
  );
  const subagents = packages.find((entry) => packageName(entry) === "pi-subagents");
  const provider = packages.find((entry) => packageName(entry) === "pi-antigravity-acp-provider");
  let providerEntry: string | undefined;
  if (provider) {
    const enabled = resolvePackageExtensions(provider);
    const index = path.join(packageSource(provider), "extensions", "index.ts");
    providerEntry = enabled.includes(index) ? index : enabled[0];
  }
  return {
    packages,
    piSubagentsRoot:
      subagents && resolvePackageExtensions(subagents).length
        ? packageSource(subagents)
        : undefined,
    piAntigravityEntryPath: providerEntry ? fs.realpathSync.native(providerEntry) : undefined,
  };
}

/** Resolve package sources to real, absolute local paths without dropping resource filters. */
export function discoverLocalPiPackages(
  sourceAgentDir: string = path.join(os.homedir(), ".pi", "agent"),
  excludePackages?: readonly string[],
): LocalPiPackages {
  const entries = packageEntries(readSettings(sourceAgentDir)).filter((entry) =>
    fs.existsSync(candidatePath(packageSource(entry), sourceAgentDir)),
  );
  return resolveLocalPiPackages(entries, sourceAgentDir, excludePackages);
}

function freshDirectory(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

type PiAcpProfileState =
  | { status: "missing" }
  | { status: "valid"; settings: Record<string, unknown> }
  | { status: "invalid"; reason: string };

function piAcpProfilePath(agentDir: string): string {
  return path.join(agentDir, "antigravity-acp-provider", "config.json");
}

function readPiAcpProfile(file: string): PiAcpProfileState {
  const directory = path.dirname(file);
  try {
    for (const parent of [path.dirname(directory), directory]) {
      const stat = fs.lstatSync(parent, { throwIfNoEntry: false });
      if (!stat) return { status: "missing" };
      if (!stat.isDirectory()) return { status: "invalid", reason: "not a regular directory" };
    }
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return { status: "missing" };
    if (!stat.isFile()) return { status: "invalid", reason: "not a regular file" };
    const previous: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!previous || typeof previous !== "object" || Array.isArray(previous))
      return { status: "invalid", reason: "expected a JSON object" };
    const settings = previous as Record<string, unknown>;
    if (
      settings.permissions !== undefined &&
      settings.permissions !== "yolo" &&
      settings.permissions !== "default" &&
      settings.permissions !== "auto_edit"
    )
      return { status: "invalid", reason: "invalid permissions mode" };
    if (
      settings.runtimeUpdates !== undefined &&
      settings.runtimeUpdates !== "automatic" &&
      settings.runtimeUpdates !== "notify" &&
      settings.runtimeUpdates !== "manual"
    )
      return { status: "invalid", reason: "invalid runtime update mode" };
    return { status: "valid", settings };
  } catch (error) {
    return {
      status: "invalid",
      reason: error instanceof SyntaxError ? "invalid JSON" : "unable to read profile",
    };
  }
}

export function inspectPiAcpProfile(
  agentDir: string,
  profile?: SessionConfig["piAcp"],
):
  | { path: string; status: "missing" | "valid" }
  | { path: string; status: "invalid"; reason: string } {
  const file = piAcpProfilePath(agentDir);
  const state = readPiAcpProfile(file);
  if (state.status === "invalid") return { path: file, ...state };
  if (
    state.status === "missing" ||
    state.settings.permissions !== (profile?.permissions ?? "yolo") ||
    state.settings.runtimeUpdates !== (profile?.runtime_updates ?? "manual")
  ) {
    let dir = path.dirname(file);
    try {
      while (!fs.statSync(dir, { throwIfNoEntry: false }) && dir !== path.dirname(dir))
        dir = path.dirname(dir);
      fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
    } catch {
      return {
        path: file,
        status: "invalid",
        reason: "unable to create or replace profile in its directory",
      };
    }
  }
  return { path: file, status: state.status };
}

function preparePiAcpProfile(agentDir: string, profile?: SessionConfig["piAcp"]): void {
  const file = piAcpProfilePath(agentDir);
  const state = readPiAcpProfile(file);
  if (state.status === "invalid") throw new Error(state.reason);
  const settings = state.status === "valid" ? state.settings : {};
  const permissions = profile?.permissions ?? "yolo";
  const runtimeUpdates = profile?.runtime_updates ?? "manual";
  if (settings.permissions === permissions && settings.runtimeUpdates === runtimeUpdates) return;

  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = fs.mkdtempSync(path.join(directory, ".profile-"));
  try {
    const staged = path.join(temporary, "config.json");
    writeJson(staged, { ...settings, permissions, runtimeUpdates });
    fs.renameSync(staged, file);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function copyCredential(source: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, 0o600);
}

function linkIfPresent(source: string, destination: string): void {
  if (!fs.existsSync(source)) return;
  try {
    fs.rmSync(destination, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  fs.symlinkSync(source, destination);
}

function prepareGeminiHome(sourceGeminiDir: string | undefined, copyCredentials: boolean): string {
  const geminiHome = freshDirectory("agent-team-gemini-home-");
  if (copyCredentials) {
    if (!sourceGeminiDir) throw new Error("sourceGeminiDir is required to copy Gemini credentials");
    for (const name of ["oauth_creds.json", "google_accounts.json"]) {
      const source = path.join(sourceGeminiDir, name);
      if (fs.existsSync(source)) copyCredential(source, path.join(geminiHome, name));
    }
  }
  return geminiHome;
}

export function prepareControlledPiAgentHome(
  options: PrepareControlledPiAgentHomeOptions,
): ControlledPiAgentHome {
  if (options.mode === "runtime" && !options.dataDir) {
    throw new Error("dataDir is required for a runtime PI_CODING_AGENT_DIR");
  }
  const defaultSource =
    options.mode === "test-synthetic" ? undefined : path.join(os.homedir(), ".pi", "agent");
  const piAgentDir =
    options.mode === "runtime"
      ? path.join(options.dataDir!, "pi-agent-home")
      : freshDirectory("agent-team-pi-agent-home-");
  fs.mkdirSync(piAgentDir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(piAgentDir).isDirectory())
    throw new Error("Managed Pi agent home must be a directory, not a symlink");

  const sourceAgentDir = options.sourceAgentDir ?? defaultSource ?? piAgentDir;
  const synthetic = options.mode === "test-synthetic";
  const discovered =
    options.packages?.length || synthetic
      ? resolveLocalPiPackages(options.packages ?? [], sourceAgentDir, options.excludePackages)
      : discoverLocalPiPackages(sourceAgentDir, options.excludePackages);
  let piAcpProfileError: string | undefined;
  if (discovered.piAntigravityEntryPath) {
    try {
      preparePiAcpProfile(piAgentDir, options.piAcp);
    } catch {
      piAcpProfileError = `Antigravity ACP is disabled. Repair the managed profile at ${piAcpProfilePath(piAgentDir)} and restart the session.`;
      discovered.piAntigravityEntryPath = undefined;
      discovered.packages = discovered.packages.filter(
        (entry) => packageName(entry) !== "pi-antigravity-acp-provider",
      );
    }
  }

  const authSource = path.join(sourceAgentDir, "auth.json");
  const authDestination = path.join(piAgentDir, "auth.json");
  if (options.mode === "test-synthetic") {
    writeJson(authDestination, {});
  } else if (options.mode === "test-copied-creds") {
    if (!fs.existsSync(authSource)) throw new Error(`Pi credentials not found: ${authSource}`);
    copyCredential(authSource, authDestination);
  } else {
    linkIfPresent(authSource, authDestination);
  }

  if (options.mode === "runtime") {
    for (const name of ["AGENTS.md", "AGENTS.local.md"]) {
      linkIfPresent(path.join(sourceAgentDir, name), path.join(piAgentDir, name));
    }
    const agentsSource = path.resolve(sourceAgentDir, "agents");
    const agentsDestination = path.join(piAgentDir, "agents");
    const existing = fs.lstatSync(agentsDestination, { throwIfNoEntry: false });
    if (fs.statSync(agentsSource, { throwIfNoEntry: false })?.isDirectory()) {
      if (existing && !existing.isSymbolicLink()) {
        // Keep definitions created locally before host agent routing was enabled.
        const backup = fs.mkdtempSync(path.join(piAgentDir, "agents-backup-"));
        fs.renameSync(agentsDestination, path.join(backup, "agents"));
      }
      if (!existing?.isSymbolicLink() || fs.readlinkSync(agentsDestination) !== agentsSource) {
        linkIfPresent(agentsSource, agentsDestination);
      }
    } else if (existing?.isSymbolicLink()) {
      // Runtime homes persist: do not retain a link from a previous preparation.
      fs.unlinkSync(agentsDestination);
    }
    const catalog = path.join(piAgentDir, "models.json");
    const catalogSource = path.resolve(sourceAgentDir, "models.json");
    const linked = fs.lstatSync(catalog, { throwIfNoEntry: false })?.isSymbolicLink();
    if (fs.existsSync(catalogSource)) {
      if (!linked || fs.readlinkSync(catalog) !== catalogSource)
        linkIfPresent(catalogSource, catalog);
    } else if (linked) fs.unlinkSync(catalog);
    const modelsSource = path.join(sourceAgentDir, "models-store.json");
    const modelsStore = path.join(piAgentDir, "models-store.json");
    const existingStore = fs.lstatSync(modelsStore, { throwIfNoEntry: false });
    if (existingStore && !existingStore.isFile())
      throw new Error("Managed Pi models-store.json must be a regular file");
    if (!existingStore && fs.existsSync(modelsSource)) copyCredential(modelsSource, modelsStore);
  }

  const sourceSettings = synthetic ? {} : readSettings(sourceAgentDir);
  const settings: Record<string, unknown> = {
    defaultProjectTrust: "always",
    packages: discovered.packages,
  };
  for (const key of ["enabledModels", "defaultProvider", "defaultModel"] as const) {
    if (sourceSettings[key] !== undefined) settings[key] = sourceSettings[key];
  }
  if (options.mode === "runtime" && sourceSettings.subagents !== undefined) {
    settings.subagents = sourceSettings.subagents;
  }
  const settingsPath = path.join(piAgentDir, "settings.json");
  writeJson(settingsPath, settings);

  const env: Record<string, string> = { PI_CODING_AGENT_DIR: piAgentDir };
  if (options.offline !== false) env.PI_OFFLINE = "1";
  let geminiHome: string | undefined;
  if (options.mode === "test-synthetic") {
    geminiHome = prepareGeminiHome(undefined, false);
  } else if (options.mode === "test-copied-creds" && options.isolateGeminiHome) {
    geminiHome = prepareGeminiHome(
      options.sourceGeminiDir ?? path.join(os.homedir(), ".gemini"),
      true,
    );
  }
  if (geminiHome) {
    env.GEMINI_HOME = geminiHome;
    env.AGY_ACP_FORCE_FILE_STORAGE = "1";
  }
  if (options.mode !== "runtime") {
    const subagentsTempRoot = freshDirectory("agent-team-pi-subagents-tmp-");
    env.PI_SUBAGENTS_TEMP_ROOT = subagentsTempRoot;
  }

  return {
    piAgentDir,
    settingsPath,
    env,
    resolvedPackages: {
      piSubagentsRoot: discovered.piSubagentsRoot,
      piAntigravityEntryPath: discovered.piAntigravityEntryPath,
    },
    ...(geminiHome && { geminiHome }),
    ...(piAcpProfileError && { piAcpProfileError }),
  };
}
