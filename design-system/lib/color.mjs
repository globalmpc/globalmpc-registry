/**
 * Colour maths for the MPC design system: oklch → sRGB hex, and WCAG contrast.
 *
 * The package has no dependencies and this is why. Tokens are authored in
 * oklch because that is what keeps a copper legible across four surface
 * depths; consumers need hex because that is what a print shop, a Flutter
 * `Color`, and a deck can use. Deriving one from the other at build time means
 * the two can never disagree — and doing it in ~60 lines is cheaper than
 * taking on a colour library that a Flutter or Figma consumer would then have
 * to reason about.
 *
 * Implements the Oklab → linear sRGB matrices from the Oklab specification,
 * then gamma-encodes and clamps to the sRGB gamut.
 */

/** Parse `oklch(L C H)` or `oklch(L C H / A)`. Returns null for other syntaxes. */
export function parseOklch(value) {
  const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+%?)\s*)?\)$/i.exec(
    String(value).trim(),
  );
  if (!match) return null;

  const alpha = match[4];
  return {
    l: Number(match[1]),
    c: Number(match[2]),
    h: Number(match[3]),
    a:
      alpha === undefined
        ? 1
        : alpha.endsWith("%")
          ? Number(alpha.slice(0, -1)) / 100
          : Number(alpha),
  };
}

function gammaEncode(channel) {
  const clamped = Math.min(1, Math.max(0, channel));
  return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
}

const hex2 = (n) => n.toString(16).padStart(2, "0").toUpperCase();

/**
 * Uppercase `#RRGGBB` for an oklch colour, clamped into the sRGB gamut.
 *
 * Alpha is dropped: the eight-digit form is not universally supported by the
 * consumers this package targets, and `alphaOf` exposes it separately for the
 * ones that want it.
 */
export function oklchToHex({ l, c, h }) {
  const hRad = (h * Math.PI) / 180;
  const a = c * Math.cos(hRad);
  const b = c * Math.sin(hRad);

  const lCone = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mCone = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sCone = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;

  const channels = [
    4.0767416621 * lCone - 3.3077115913 * mCone + 0.2309699292 * sCone,
    -1.2684380046 * lCone + 2.6097574011 * mCone - 0.3413193965 * sCone,
    -0.0041960863 * lCone - 0.7034186147 * mCone + 1.707614701 * sCone,
  ];

  return `#${channels.map((channel) => hex2(Math.round(gammaEncode(channel) * 255))).join("")}`;
}

/** `#RRGGBB` for any supported colour syntax — oklch or an existing hex literal. */
export function toHex(value) {
  const parsed = parseOklch(value);
  if (parsed) return oklchToHex(parsed);

  const hex = /^#([0-9a-f]{6})$/i.exec(String(value).trim());
  if (hex) return `#${hex[1].toUpperCase()}`;

  return null;
}

/** Alpha channel, 0–1. Opaque colours and non-oklch syntaxes return 1. */
export function alphaOf(value) {
  return parseOklch(value)?.a ?? 1;
}

/** `0xAARRGGBB` literal for Dart's `Color`. */
export function toArgb(value) {
  const hex = toHex(value);
  if (!hex) return null;
  return `0x${hex2(Math.round(alphaOf(value) * 255))}${hex.slice(1)}`;
}

function channelLuminance(srgb) {
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an `#RRGGBB` colour, 0–1. */
export function luminance(hex) {
  const value = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) =>
    channelLuminance(parseInt(value.slice(i, i + 2), 16) / 255),
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two `#RRGGBB` colours, 1–21. */
export function contrastRatio(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}
