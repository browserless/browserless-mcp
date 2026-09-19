import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

export class InvalidUploadPathError extends Error {}

export const assertAllowedUploadPath = (
  path: string,
  roots: string[],
): string => {
  let canonical: string;
  try {
    if (!path) throw new InvalidUploadPathError();
    canonical = realpathSync(resolve(path));
  } catch {
    throw new InvalidUploadPathError('Invalid upload path');
  }

  for (const root of roots) {
    if (!root) continue;
    let canonicalRoot: string;
    try {
      canonicalRoot = realpathSync(resolve(root));
    } catch {
      // The download directory may not exist until the first download.
      continue;
    }
    const prefix = canonicalRoot.endsWith(sep)
      ? canonicalRoot
      : canonicalRoot + sep;
    if (canonical.startsWith(prefix)) return canonical;
  }
  throw new InvalidUploadPathError(
    'Upload path is outside the allowed directories',
  );
};
