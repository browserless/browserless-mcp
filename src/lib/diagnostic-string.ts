// Quote log values and escape controls, format characters, and line separators.
// Bound the input first so escaping cannot amplify an unbounded preview.
export const diagnosticString = (value: string): string => {
  let preview = '';
  let length = 0;
  for (const char of value) {
    if (length++ === 80) break;
    preview += char;
  }
  return (
    JSON.stringify(preview).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (char) =>
      char
        .split('')
        .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)
        .join(''),
    ) + (value.length > preview.length ? '…' : '')
  );
};
