import type { NextRequest } from "next/server";
import { forwardStreamUpload } from "@/lib/stream-upload";

/**
 * The streaming upload, piped to the API without the proxy's body buffering (`lib/stream-upload.ts`).
 * `proxy.ts` leaves this path out of its matcher so the body reaches here whole.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: NextRequest): Promise<Response> {
  return forwardStreamUpload(request);
}
