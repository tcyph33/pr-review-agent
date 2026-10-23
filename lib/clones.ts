import fs from "fs";
import os from "os";
import path from "path";

/**
 * Where the review skill clones PRs for inspection. Clones are an implementation
 * detail of the review process rather than something the user manages, so they
 * are cleaned up alongside the review that created them.
 */
export const PR_REVIEWS_ROOT = path.join(os.homedir(), "PR-Reviews");

interface ClonedReview {
  repo: string;
  pull_number: number;
}

/**
 * Builds the directory the review skill clones a PR into.
 *
 * @param review - The review whose clone directory is wanted
 * @param root - Clone root, overridable for tests
 * @returns The absolute path, or null when the record carries no usable repo name
 */
export function cloneDirectoryFor(review: ClonedReview, root: string = PR_REVIEWS_ROOT): string | null {
  // The owner is part of the name because two orgs can own a repo of the same
  // name. Without it, acme/web#5 and other/web#5 share a directory, so deleting
  // one review's clone would remove the checkout the other is still using.
  const [owner, repoName] = review.repo.split("/");

  const hasBothParts = Boolean(owner) && Boolean(repoName);
  if (!hasBothParts) return null;

  const directory = path.join(root, `${owner}-${repoName}-${review.pull_number}`);
  return directory;
}

/**
 * Removes the local clone made for a PR.
 *
 * @param review - The review whose clone should be removed
 * @param root - Clone root, overridable for tests
 * @returns True when something was actually removed
 */
export function deleteCloneDirectory(review: ClonedReview, root: string = PR_REVIEWS_ROOT): boolean {
  const cloneDirectory = cloneDirectoryFor(review, root);

  const hasCloneDirectory = cloneDirectory !== null;
  if (!hasCloneDirectory) return false;

  // Refuse any path that does not sit strictly inside the clone root. A repo
  // name containing path separators would otherwise walk the deletion upward,
  // and this function deletes recursively.
  const resolved = path.resolve(cloneDirectory);
  const rootPrefix = path.resolve(root) + path.sep;
  const isInsideRoot = resolved.startsWith(rootPrefix);
  if (!isInsideRoot) return false;

  // lstat rather than stat: a symlink must be unlinked, never followed into.
  // Following one would delete whatever it points at, outside the root entirely.
  let entry: fs.Stats;
  try {
    entry = fs.lstatSync(resolved);
  } catch {
    // Nothing there — a review whose agent run failed may never have cloned
    return false;
  }

  const isSymbolicLink = entry.isSymbolicLink();
  if (isSymbolicLink) {
    fs.unlinkSync(resolved);
    return true;
  }

  fs.rmSync(resolved, { recursive: true, force: true });
  return true;
}
