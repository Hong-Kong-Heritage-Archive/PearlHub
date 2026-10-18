import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PearlHub — Discover Pearls",
  description: "Discover portable, community-built Pearls on PearlHub.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
