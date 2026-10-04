import type { Metadata, Viewport } from "next";
import "./globals.css";
import { StoreProvider } from "@/lib/store";
import { TopBar } from "@/components/TopBar";

export const metadata: Metadata = {
  title: { default: "JalLog – paper plant logbooks, read and checked", template: "%s – JalLog" },
  description:
    "Photograph a page of an STP or ETP register. JalLog reads it, shows every value to a person beside the photo before anything is saved, and fixed rules check the readings against consent limits and for gaps or repeated entries.",
  applicationName: "JalLog",
  appleWebApp: { capable: true, title: "JalLog", statusBarStyle: "default" },
  formatDetection: { telephone: false, date: false, address: false, email: false },
};

// The page is designed in light colours only. Declaring it stops a phone in
// dark mode from inverting form controls or scrollbars into unreadable ones.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#fcfcfb",
  colorScheme: "light",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#main">Skip to content</a>
        <StoreProvider>
          <TopBar />
          <main className="main" id="main" tabIndex={-1}>{children}</main>
        </StoreProvider>
      </body>
    </html>
  );
}
