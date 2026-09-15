import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Movie File Renamer",
  description: "Rename files recursively with optional local Ollama suggestions."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
