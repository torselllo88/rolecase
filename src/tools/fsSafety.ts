import path from "node:path";

/**
 * Resolves `fileName` inside `dir` and throws unless the result is still
 * actually inside `dir` — the standard defense against a `../../etc/passwd`
 * -style id/filename escaping the intended folder. Used by every admin CRUD
 * helper that turns a client-supplied id into a path on disk (resumes,
 * answer examples, cover letters), mirroring the same `startsWith(dir)`
 * technique `gui/server.ts`'s `serveStatic()` already uses for static files.
 */
export function resolveInsideDir(dir: string, fileName: string): string {
  const resolvedDir = path.resolve(dir);
  const resolvedPath = path.resolve(resolvedDir, fileName);
  if (resolvedPath !== resolvedDir && !resolvedPath.startsWith(resolvedDir + path.sep)) {
    throw new Error("Invalid file name.");
  }
  return resolvedPath;
}
