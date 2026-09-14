import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { SessionProvider } from "@/lib/session";
import { TopBar } from "@/components/TopBar";

export const metadata: Metadata = {
  title: "MPC Registry Workspace",
  description:
    "Mining Compliance Evidence & Registry Infrastructure. Verification is not a guarantee.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // The service runs in English only (OD-30). Screen readers and browser
  // translators read this attribute, so it states the one language we render.
  return (
    <html lang="en">
      <body>
        <SessionProvider>
          <div className="shell">
            <TopBar />
            <main className="main">{children}</main>
            {/*
              약관·데이터 처리·지원은 footer에 둔다. 공개 navigation은
              스펙 11 §11.2의 일곱 항목이고, 여기에 여덟 번째를 끼우면 그 목록이
              무엇을 뜻하는지가 흐려진다.
            */}
            <footer className="footer">
              <Link href="/legal">Terms, data handling, and support</Link>
            </footer>
          </div>
        </SessionProvider>
      </body>
    </html>
  );
}
