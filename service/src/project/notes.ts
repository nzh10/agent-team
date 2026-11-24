import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { writeAtomicText } from "../storage/atomic-write";

export const NOTE_SLUG_PATTERN =
  /^(?!.*\.\.)(?!.*\.[mM][dD]$)[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}(?![\s\S])/;

export interface NoteSummary {
  slug: string;
  version: string;
  sizeBytes: number;
  updatedAt: number;
}

export interface Note extends NoteSummary {
  content: string;
}

export class NoteVersionConflictError extends Error {
  readonly code = "NOTE_VERSION_CONFLICT";

  constructor(
    slug: string,
    readonly currentVersion: string | null,
  ) {
    super(
      `Note "${slug}" has a version conflict (current version: ${currentVersion ?? "none"}). ` +
        "Call read_note again and retry with its current expected_version.",
    );
    this.name = "NoteVersionConflictError";
  }
}

// Slugs are extensionless: "design" is stored as design.md. An explicit .md
// suffix is rejected rather than normalized, so every API names a note the
// same way and no write accidentally creates a double extension.
export function validateNoteSlug(slug: string): string {
  if (!NOTE_SLUG_PATTERN.test(slug)) {
    throw new Error(
      `Bad note slug "${slug}": use 1-128 letters, digits, dots, underscores or hyphens; ` +
        "start with a letter or digit, omit .md, and do not use '..', path separators, whitespace or control characters",
    );
  }
  return slug;
}

export function computeNoteVersion(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

function missingPath(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function resolveNotesDir(notesDir: string, create: boolean): string | null {
  let linkStat: fs.Stats | null = null;
  try {
    linkStat = fs.lstatSync(notesDir);
  } catch (error) {
    if (!missingPath(error)) throw error;
    if (!create) return null;
    fs.mkdirSync(notesDir, { recursive: true });
    linkStat = fs.lstatSync(notesDir);
  }
  if (linkStat.isSymbolicLink()) {
    throw new Error(`Notes directory "${notesDir}" must not be a symbolic link`);
  }
  if (!linkStat.isDirectory()) {
    throw new Error(`Notes path "${notesDir}" is not a directory`);
  }
  const realDir = fs.realpathSync.native(notesDir);
  const realParent = fs.realpathSync.native(path.dirname(notesDir));
  if (
    path.dirname(realDir) !== realParent ||
    path.basename(realDir) !== path.basename(notesDir) ||
    !fs.statSync(realDir).isDirectory()
  ) {
    throw new Error(`Notes directory "${notesDir}" resolves outside its project directory`);
  }
  return realDir;
}

function assertInside(realDir: string, realTarget: string, slug: string): void {
  const relative = path.relative(realDir, realTarget);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `Note "${slug}" resolves outside the notes directory; refusing symbolic-link escape`,
    );
  }
}

interface InspectedNote {
  file: string;
  stat: fs.Stats;
}

function inspectNote(realDir: string, slug: string): InspectedNote | null {
  const file = path.join(realDir, `${slug}.md`);
  let linkStat: fs.Stats;
  try {
    linkStat = fs.lstatSync(file);
  } catch (error) {
    if (missingPath(error)) return null;
    throw error;
  }

  // realpath checks regular files too, and resolves a symlink before the
  // containment check. lstat ensures a dangling link is never treated as an
  // absent note that can safely be replaced.
  const realTarget = fs.realpathSync.native(file);
  assertInside(realDir, realTarget, slug);
  const stat = fs.statSync(realTarget);
  if (!stat.isFile()) throw new Error(`Note "${slug}" is not a regular file`);
  if (linkStat.isSymbolicLink()) assertInside(realDir, realTarget, slug);
  return { file, stat };
}

function conflictIfNeeded(
  slug: string,
  currentContent: string | null,
  expectedVersion: string | null | undefined,
): void {
  const currentVersion = currentContent === null ? null : computeNoteVersion(currentContent);
  if (currentVersion === null) {
    if (expectedVersion) throw new NoteVersionConflictError(slug, null);
    return;
  }
  if (expectedVersion !== currentVersion) throw new NoteVersionConflictError(slug, currentVersion);
}

function existingContent(
  realDir: string,
  slug: string,
): { content: string; stat: fs.Stats } | null {
  const note = inspectNote(realDir, slug);
  if (!note) return null;
  return { content: fs.readFileSync(note.file, "utf8"), stat: note.stat };
}

export function listNotes(notesDir: string): NoteSummary[] {
  const realDir = resolveNotesDir(notesDir, false);
  if (!realDir) return [];
  const notes: NoteSummary[] = [];
  for (const entry of fs.readdirSync(realDir, { withFileTypes: true })) {
    if (!entry.name.endsWith(".md")) continue;
    const slug = entry.name.slice(0, -3);
    try {
      validateNoteSlug(slug);
      const note = inspectNote(realDir, slug);
      if (!note) continue;
      const content = fs.readFileSync(note.file, "utf8");
      notes.push({
        slug,
        version: computeNoteVersion(content),
        sizeBytes: note.stat.size,
        updatedAt: note.stat.mtimeMs,
      });
    } catch {
      // Invalid names, directories and unsafe or dangling symlinks are not
      // project notes. A valid neighboring note must remain listable.
    }
  }
  return notes.sort((a, b) => a.slug.localeCompare(b.slug));
}

export function readNote(notesDir: string, slugInput: string): Note {
  const slug = validateNoteSlug(slugInput);
  const realDir = resolveNotesDir(notesDir, false);
  const existing = realDir ? existingContent(realDir, slug) : null;
  if (!existing)
    throw new Error(`Note "${slug}" does not exist; call list_notes to see available notes`);
  return {
    slug,
    content: existing.content,
    version: computeNoteVersion(existing.content),
    sizeBytes: existing.stat.size,
    updatedAt: existing.stat.mtimeMs,
  };
}

export function writeNote(
  notesDir: string,
  slugInput: string,
  content: string,
  expectedVersion?: string | null,
): NoteSummary {
  const slug = validateNoteSlug(slugInput);
  const realDir = resolveNotesDir(notesDir, true)!;
  const before = existingContent(realDir, slug);
  conflictIfNeeded(slug, before?.content ?? null, expectedVersion);

  const file = path.join(realDir, `${slug}.md`);
  writeAtomicText(file, content, () => {
    // Recheck containment and version immediately before replacing the target.
    const current = existingContent(realDir, slug);
    conflictIfNeeded(slug, current?.content ?? null, expectedVersion);
  });

  const written = inspectNote(realDir, slug);
  if (!written) throw new Error(`Note "${slug}" disappeared after it was written`);
  return {
    slug,
    version: computeNoteVersion(content),
    sizeBytes: written.stat.size,
    updatedAt: written.stat.mtimeMs,
  };
}

export class ProjectNotesStore {
  constructor(readonly notesDir: string) {}

  listNotes(): NoteSummary[] {
    return listNotes(this.notesDir);
  }

  readNote(slug: string): Note {
    return readNote(this.notesDir, slug);
  }

  writeNote(slug: string, content: string, expectedVersion?: string | null): NoteSummary {
    return writeNote(this.notesDir, slug, content, expectedVersion);
  }
}
