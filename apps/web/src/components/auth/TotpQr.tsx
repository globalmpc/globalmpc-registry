import { encode } from "uqr";

/**
 * The `otpauth://` URI as a QR code, drawn here as SVG rectangles.
 *
 * **The secret never leaves this page.** A QR service or a chart API would receive the URI — and
 * the secret in it. Encoding in the browser and drawing plain SVG elements also needs no CSP
 * allowance: no `data:` image, no canvas, no external fetch.
 */
export function TotpQr({ uri, size = 192 }: { readonly uri: string; readonly size?: number }) {
  const { data, size: modules } = encode(uri, { ecc: "M", border: 2 });
  const cells: string[] = [];
  data.forEach((row, y) =>
    row.forEach((on, x) => {
      if (on) cells.push(`M${x} ${y}h1v1h-1z`);
    }),
  );
  return (
    <svg
      role="img"
      aria-label="QR code for your authenticator app"
      data-testid="totp-qr"
      width={size}
      height={size}
      viewBox={`0 0 ${modules} ${modules}`}
      shapeRendering="crispEdges"
      style={{ background: "#fff", borderRadius: "var(--radius-md)" }}
    >
      <path d={cells.join("")} fill="#000" />
    </svg>
  );
}
