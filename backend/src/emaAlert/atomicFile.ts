/**
 * Atomic, permission-locked JSON file persistence for backend/data/*.json.
 *
 * Writes follow the crash-safe pattern:
 *   1. write to a temp file (0600) in the SAME directory
 *   2. fsync the temp file
 *   3. rename over the destination (atomic on POSIX)
 * A process crash mid-write can never leave a partially-written JSON file —
 * the destination is only replaced once the temp file is fully durable.
 *
 * Permissions: the target directory is created with 0700 and files at 0600
 * (single-user Oracle VM safety).
 */
import fs from "node:fs";
import path from "node:path";

/** Ensure the parent directory exists with 0700 (never affects functionality). */
export function ensurePrivateDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o700);
  } catch {
    /* read-only/permission edge — the caller's write attempt decides */
  }
}

/** Atomically write `data` as pretty-printed JSON to `filePath` (0600). */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  ensurePrivateDir(dir);
  const tmp = `${filePath}.${process.pid}.${Date.now().toString(36)}.tmp`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, "w", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      /* mode already applied at open on POSIX */
    }
    fs.renameSync(tmp, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      /* best-effort */
    }
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}