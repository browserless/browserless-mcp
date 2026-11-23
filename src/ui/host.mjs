import {
  applyDocumentTheme,
  applyHostStyleVariables,
  applyHostFonts,
} from '@modelcontextprotocol/ext-apps';

export const HOST_PALETTE_KEYS = [
  '--color-background-primary',
  '--color-background-secondary',
  '--color-text-primary',
  '--color-text-secondary',
  '--color-border-primary',
];

export function applyHostContext(context, root = document.documentElement) {
  if (context.theme) applyDocumentTheme(context.theme);
  const variables = context.styles?.variables ?? {};
  applyHostStyleVariables(variables, root);
  // The SDK retains old properties; only the latest complete palette is usable.
  root.toggleAttribute(
    'data-host-palette',
    HOST_PALETTE_KEYS.every(
      (key) =>
        typeof variables[key] === 'string' && variables[key].trim() !== '',
    ),
  );
  const fonts = context.styles?.css?.fonts;
  if (typeof fonts === 'string' && fonts.trim()) applyHostFonts(fonts);
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const inset = context.safeAreaInsets?.[side];
    if (Number.isFinite(inset) && inset >= 0)
      root.style.setProperty(`--safe-${side}`, `${inset}px`);
    else root.style.removeProperty(`--safe-${side}`);
  }
  const caps = context.deviceCapabilities ?? {};
  const coarse =
    caps.touch === true ||
    caps.hover === false ||
    (caps.touch !== false &&
      caps.hover !== true &&
      (context.platform === 'mobile' ||
        window.matchMedia('(pointer: coarse)').matches));
  root.dataset.input = coarse ? 'touch' : 'pointer';
  const dims = context.containerDimensions ?? {};
  root.style.removeProperty('--host-height');
  root.style.removeProperty('--host-max-height');
  if (Number.isFinite(dims.height) && dims.height > 0)
    root.style.setProperty('--host-height', `${dims.height}px`);
  else if (Number.isFinite(dims.maxHeight) && dims.maxHeight > 0)
    root.style.setProperty('--host-max-height', `${dims.maxHeight}px`);
}

export function resolveFormat(host) {
  let locale, timeZone;
  try {
    if (typeof host.locale === 'string')
      locale = Intl.getCanonicalLocales(host.locale)[0];
  } catch {
    /* Invalid host locale uses the viewer's settings. */
  }
  try {
    if (typeof host.timeZone === 'string') {
      new Intl.DateTimeFormat('en-US', { timeZone: host.timeZone });
      timeZone = host.timeZone;
    }
  } catch {
    /* Invalid host time zone uses the viewer's settings. */
  }
  return { locale, timeZone };
}

export function formatTimestamp(value, host) {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const { locale, timeZone } = resolveFormat(host);
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'short',
    timeStyle: 'medium',
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

export function formatNumber(value, host, suffix = '') {
  if (value === null || value === undefined) return 'Unavailable';
  const { locale } = resolveFormat(host);
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 20 }).format(value)}${suffix}`;
}

export function formatDuration(seconds, host) {
  const { locale } = resolveFormat(host);
  const fmt = (value, unit) =>
    new Intl.NumberFormat(locale, {
      style: 'unit',
      unit,
      unitDisplay: 'narrow',
    }).format(value);
  return seconds >= 60
    ? `${fmt(Math.floor(seconds / 60), 'minute')} ${fmt(seconds % 60, 'second')}`
    : fmt(seconds, 'second');
}
