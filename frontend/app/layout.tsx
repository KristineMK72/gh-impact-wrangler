import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "gh-impact wrangler",
  description: "Zero-friction geographic data cleaning: CSV/coords → clean GeoJSON",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
