// Framework-generated ids (React useId, Radix, Headless UI, MUI) change on re-render.
export const FRAMEWORK_ID = /(radix-|headlessui-|mui-[a-z]|«r|:r[0-9a-z]|_r_)/i;

export const selectorHasFrameworkId = (selector: string): boolean => {
  // Skip quoted values and escapes outside ID tokens; accept legacy React refs.
  const tokens =
    /\\.|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|#((?:\\.|[\w\u0080-\uffff-])+|:r[0-9a-z]+:)/gi;
  for (const [, id] of selector.matchAll(tokens)) {
    if (id && FRAMEWORK_ID.test(id.replace(/\\(.)/g, '$1'))) return true;
  }
  return false;
};
