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
              Terms, data processing, and support live in the footer. Public navigation is
              the seven items of spec 11 §11.2; inserting an eighth blurs what
              that list means.
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
