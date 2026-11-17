import type { Metadata } from "next";
import { FirebaseAuthProvider } from "../components/firebase-auth-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "PearlHub — Discover Pearls",
  description: "Discover portable, community-built Pearls on PearlHub.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body><FirebaseAuthProvider>{children}</FirebaseAuthProvider></body>
    </html>
  );
}
