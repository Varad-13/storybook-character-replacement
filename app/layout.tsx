import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Storybook Recast",
  description: "Re-issue a finished picture book for a different family.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
