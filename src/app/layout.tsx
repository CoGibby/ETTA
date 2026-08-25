import type { Metadata } from "next";
import { Source_Sans_3 } from "next/font/google";
import "./globals.css";
import "./etta.css";
import { DataProvider } from "@/lib/data-context";
import { ConnectionProvider } from "@/lib/connection-context";
import { AppShell } from "@/components/AppShell";

const sourceSans = Source_Sans_3({
  variable: "--font-source-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "ETTA · Time Tracker",
  description: "ETTA turns your calendar and email into Jira time entries.",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${sourceSans.variable} font-sans antialiased`}>
        <ConnectionProvider>
          <DataProvider>
            <AppShell>{children}</AppShell>
          </DataProvider>
        </ConnectionProvider>
      </body>
    </html>
  );
}
