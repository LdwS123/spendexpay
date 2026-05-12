import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import CookieBanner from "./components/CookieBanner";

// Load Geist fonts from Google Fonts and expose them as CSS variables.
// next/font handles subsetting and self-hosting automatically — no CORS issues.
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const siteUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://spendexai.com";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Spendex Pay — The wallet for your AI agent",
    template: "%s — Spendex Pay",
  },
  description:
    "Install once in Claude Code, Cursor or ChatGPT. Your AI agents sign up and pay for any service, within the rules you set.",
  applicationName: "Spendex Pay",
  keywords: [
    "AI agent wallet",
    "MCP",
    "Model Context Protocol",
    "Stripe Issuing",
    "autonomous payment",
    "Claude Code",
    "Cursor",
    "agent commerce",
    "virtual card",
    "agent-native payments",
  ],
  authors: [{ name: "Spendex Pay", url: siteUrl }],
  creator: "Spendex Pay",
  publisher: "Spendex Pay",
  category: "technology",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: siteUrl,
    siteName: "Spendex Pay",
    title: "Spendex Pay — The wallet for your AI agent",
    description:
      "Install once in Claude Code, Cursor or ChatGPT. Your AI agents sign up and pay for any service, within the rules you set.",
    images: [
      {
        url: "/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Spendex Pay — The wallet for your AI agent",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: "@spendexai",
    creator: "@spendexai",
    title: "Spendex Pay — The wallet for your AI agent",
    description:
      "Install once in Claude Code, Cursor or ChatGPT. Your AI agents sign up and pay for any service, within the rules you set.",
    images: ["/twitter-image"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    shortcut: "/favicon.ico",
    apple: [{ url: "/apple-touch-icon.svg", sizes: "180x180" }],
  },
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  themeColor: "#070d18",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="min-h-screen bg-white font-sans">
        {children}
        <CookieBanner />
      </body>
    </html>
  );
}
