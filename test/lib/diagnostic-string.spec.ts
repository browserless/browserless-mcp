import { expect } from 'chai';
import { diagnosticString } from '../../src/lib/diagnostic-string.js';

describe('diagnosticString', () => {
  it('round-trips quotes, backslashes and Unicode controls without raw unsafe characters', () => {
    const value =
      '"\\\n\r\t\u0000\u007f\u0085\u202e\u2066\u200b\ufeff\u2028\u2029\u{e0001}';
    for (let i = 0; i < 2; i++) {
      const encoded = diagnosticString(value);
      expect(encoded).not.to.match(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
      expect(JSON.parse(encoded)).to.equal(value);
    }
  });

  it('bounds the input by code point and marks only truncated previews', () => {
    const boundary = 'a'.repeat(79) + '😀';
    expect(diagnosticString(boundary)).to.equal(JSON.stringify(boundary));
    expect(diagnosticString(boundary + 'z')).to.equal(
      JSON.stringify(boundary) + '…',
    );
    expect(diagnosticString('\u202e'.repeat(1024))).to.equal(
      '"' + '\\u202e'.repeat(80) + '"…',
    );
    expect(diagnosticString('')).to.equal('""');
    const reason = 'a'.repeat(100) + '\n\u202e';
    expect(JSON.parse(diagnosticString(reason, Infinity))).to.equal(reason);
    expect(diagnosticString(reason, Infinity)).not.to.match(
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u,
    );
  });
});
