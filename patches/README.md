# Temporary picomatch mitigation

`picomatch+4.0.7.patch` mitigates
[GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)
in our development dependency tree. It is a local mitigation, not an official
upstream release. Package versions and lockfile integrity values are unchanged.

`npm ci` / `npm install` applies the patch during `prepare`, before development
tools run. Applying it again is safe. The script rejects unexpected versions,
original source bytes, patched source bytes, or patch-file bytes. All locked
picomatch copies must be development-only. Git must be available to apply it.
The existing consumer `postinstall` is unchanged; neither this patch nor its
CI scripts are included in the published tarball.

## Matching behavior

The patch removes the outer unbounded quantifier for single wildcard branches
made only of text (including literal commas), stars and question marks, without
separators or escapes.
Their positive repetition is equivalent to one copy; zero-or-more repetition
is equivalent to an optional copy. Captures represent that collapsed copy,
not the last iteration of the original repeated capture.

Other repeated wildcard forms (including alternatives, character classes,
nested groups, literal dots and paths) use picomatch's existing literal-matching fallback
unless its existing analysis supplies a safe equivalent. This deliberately
restricts complex extglobs rather than assuming a semantics-preserving rewrite.
For example, `+(*.js)` matches the literal `+(*.js)`, not `a.js` or `a.js.js`,
and `*(*.ts)` matches the literal `*(*.ts)`, not `x.ts`. These dotted repeated
extglobs are intentionally outside the supported collapsing cases.
In Bash mode, repeated wildcard branches containing question marks or literal
line breaks also fall back to literal matching: Bash's star cannot absorb the
line breaks that a question mark or literal can match.
For example, `*(a*|b)` now matches literally instead of matching `ax`; the
upstream test expecting `ax` to match intentionally fails under this mitigation.
Ordinary tooling globs such as `**/*`, extension filters and brace alternatives
are unaffected. This is not a general guarantee against every possible costly
glob expression.

## Audit exception

Run `npm run audit:security` for the Package hygiene gate. It prints the complete
development-inclusive audit and a separate production-only audit, verifies
the patch without silently repairing it, and executes the security regressions.
Only this advisory and findings inherited from it are excepted, and only in
the development tree. Other high/critical advisories, production high/critical
findings, malformed reports, unexpected dependency versions, missing patches,
changed parser bytes, and failed regressions remain blocking. Existing moderate
findings remain visible, with the same high-severity threshold as before.

**The exception expires at 2026-11-24 00:00 UTC.** It cannot be renewed through
an environment variable. Replace this mitigation with an upstream fixed release
when available, remove the `prepare` hook and security-specific scripts/tests,
and restore the ordinary `npm audit --audit-level=high` CI step. Until then,
changes to picomatch's version or installation paths require explicit review.
