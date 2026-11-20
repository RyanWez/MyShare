import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { ThemeProvider } from "@/components/ThemeProvider";
import PwaRegister from "@/components/PwaRegister";

// Plex was drawn for technical systems and its sans and mono were designed
// together — the figures line up between a label and the number beside it.
// Bundled locally via next/font/local so Docker/CI builds never fail fetching Google Fonts.
const sans = localFont({
  src: "./fonts/ibm-plex-sans-latin.woff2",
  weight: "400 600",
  style: "normal",
  variable: "--font-sans",
  display: "swap",
});

const mono = localFont({
  src: [
    { path: "./fonts/ibm-plex-mono-latin-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-mono-latin-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/ibm-plex-mono-latin-600.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "MyShare · Mytel transfer console",
  description: "Send Mytel balance between SIMs and keep the log.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "MyShare",
  },
  icons: {
    icon: "/favicon.ico",
    apple: "/icons/apple-touch-icon.png",
  },
};

// Chrome picks the title-bar / OS-chrome color from here; both themes covered.
export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F4F2EE" },
    { media: "(prefers-color-scheme: dark)", color: "#111520" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <body className="min-h-screen antialiased bg-substrate text-ink selection:bg-brass-wash selection:text-ink">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          {children}
          <PwaRegister />
        </ThemeProvider>
      </body>
    </html>
  );
}
