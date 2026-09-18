import { expect } from 'chai';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  assertAllowedUploadPath,
  InvalidUploadPathError,
} from '../../src/lib/upload-path-guard.js';

describe('Upload path guard', () => {
  let dir: string;
  let root: string;
  let file: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'upload-guard-')));
    root = join(dir, 'safe');
    mkdirSync(root);
    file = join(root, 'file.txt');
    writeFileSync(file, 'inside');
    writeFileSync(join(dir, 'outside.txt'), 'outside');
    mkdirSync(join(dir, 'safe-evil'));
    writeFileSync(join(dir, 'safe-evil', 'file.txt'), 'sibling');
    symlinkSync(join(dir, 'outside.txt'), join(root, 'escape'));
    symlinkSync(file, join(root, 'inside-link'));
    symlinkSync(root, join(dir, 'root-link'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns the canonical path for nested, relative and symlinked paths and roots', () => {
    for (const candidate of [
      file,
      relative(process.cwd(), file),
      join(root, 'inside-link'),
    ]) {
      expect(assertAllowedUploadPath(candidate, [root])).to.equal(file);
      expect(
        assertAllowedUploadPath(candidate, [join(dir, 'root-link')]),
      ).to.equal(file);
    }
  });

  it('rejects absolute escape, traversal, symlink escape and sibling prefixes', () => {
    for (const candidate of [
      join(dir, 'outside.txt'),
      `${root}/../outside.txt`,
      join(root, 'escape'),
      join(dir, 'safe-evil', 'file.txt'),
    ]) {
      expect(
        () => assertAllowedUploadPath(candidate, [root]),
        candidate,
      ).to.throw(InvalidUploadPathError);
    }
  });

  it('fails closed on empty roots and missing or invalid paths', () => {
    expect(() => assertAllowedUploadPath(file, [])).to.throw(
      InvalidUploadPathError,
    );
    for (const candidate of [join(root, 'missing'), `${file}\0suffix`, '']) {
      expect(() => assertAllowedUploadPath(candidate, [root])).to.throw(
        InvalidUploadPathError,
      );
    }
    expect(() => assertAllowedUploadPath(file, [''])).to.throw(
      InvalidUploadPathError,
    );
  });

  it('ignores unavailable roots without disabling an existing explicit root', () => {
    expect(
      assertAllowedUploadPath(file, [join(dir, 'missing'), root]),
    ).to.equal(file);
    expect(() =>
      assertAllowedUploadPath(file, [join(dir, 'missing')]),
    ).to.throw(InvalidUploadPathError);
  });
});
