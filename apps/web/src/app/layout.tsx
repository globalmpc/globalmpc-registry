import type { Metadata } from "next";
import { PublicFooter } from "@/components/PublicFooter";
import "./globals.css";
import "./reference-layout.css";
import { SessionProvider } from "@/lib/session";
import { PageFrame } from "@/components/PageFrame";
import { TopBar } from "@/components/TopBar";
import { StepUpProvider } from "@/components/auth/StepUp";

export const metadata: Metadata = {
  title: "MPC Registry Workspace",
  icons: {
    icon: { url: "/favicon.ico", type: "image/x-icon", sizes: "16x16 24x24 32x32 48x48 64x64 128x128 256x256" },
  },
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
          <StepUpProvider>
          <div className="shell">
            <a className="skip-link" href="#main">Skip to main content</a>
            <TopBar />
            <PageFrame>{children}</PageFrame>
            {/*
              Terms, data processing, and support live in the footer. Public navigation is
              the seven items of spec 11 §11.2; inserting an eighth blurs what
              that list means.
            */}
            <PublicFooter />
          </div>
          </StepUpProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
