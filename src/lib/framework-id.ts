// Framework-generated ids (React useId, Radix, Headless UI, MUI) change on re-render.
export const FRAMEWORK_ID = /(radix-|headlessui-|mui-[a-z]|«r|:r[0-9a-z]|_r_)/i;

export const selectorHasFrameworkId = (selector: string): boolean => {
  // Match explicit IDs, skipping quotes and escapes outside those tokens.
  const tokens =
    /\[\s*id\s*=\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|((?:\\.|[\w\u0080-\uffff-])+))\s*(?:[is]\s*)?\]|\\.|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|#((?:\\.|[\w\u0080-\uffff-])+|:r[0-9a-z]+:)/gi;
  for (const [
    ,
    doubleQuoted,
    singleQuoted,
    unquoted,
    hash,
  ] of selector.matchAll(tokens)) {
    const id = doubleQuoted ?? singleQuoted ?? unquoted ?? hash;
    if (id && FRAMEWORK_ID.test(id.replace(/\\(.)/g, '$1'))) return true;
  }
  return false;
};
