export const UNSAFE_DIAGNOSTIC_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

// Truncate by code point before escaping can amplify the input.
export const diagnosticPreview = (value: string, maxLength = 80): string => {
  let preview = '';
  let length = 0;
  for (const char of value) {
    if (length++ === maxLength) break;
    preview += char;
  }
  return preview;
};

// Infinity preserves complete protocol-bounded errors and server-built keys.
export const diagnosticString = (value: string, maxLength = 80): string => {
  const preview = diagnosticPreview(value, maxLength);
  return (
    JSON.stringify(preview).replace(UNSAFE_DIAGNOSTIC_CHARACTERS, (char) =>
      char
        .split('')
        .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)
        .join(''),
    ) + (value.length > preview.length ? '…' : '')
  );
};
