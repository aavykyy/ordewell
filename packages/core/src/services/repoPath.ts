/**
 * The path of the repo in a workspace that is itself the repository. Kept in
 * its own module, with no imports, so a browser surface can word a merge
 * result without pulling in the isolation record's `path` dependency.
 */
export const SELF_REPO = '.';
