import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  // Generic on purpose: the product has no name yet.
  title: "Vehicle Movement Platform",
  description: "Multi-tenant vehicle movement management with proof of collection and delivery.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
