import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import { Footer } from "@/components/layout/Footer";
import { Header } from "@/components/layout/Header";
import { AgentCartBridge } from "@/components/storefront/agent-cart-bridge";
import "@/styles/agent.css";
import "./globals.css";

// agent-storefront widget (agent-storefront/server, :4000 in dev). See
// agent-storefront/docs/NEXTCART.md. Env-driven, defaults to localhost:4000
// so a fresh clone with no .env.local still loads it in dev.
const AGENT_URL = process.env.NEXT_PUBLIC_AGENT_URL ?? "http://localhost:4000";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "NextCart",
  description: "NextCart — a plain e-commerce storefront.",
};

/**
 * Props are typed explicitly rather than with Next's generated `LayoutProps`
 * global: that type only exists once `.next/types` has been emitted, so a
 * fresh clone running `tsc --noEmit` before its first build failed with
 * "Cannot find name 'LayoutProps'". This works at any point in the cycle.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-white text-slate-900">
        <Header />
        <main className="flex flex-1 flex-col">{children}</main>
        <Footer />
        <AgentCartBridge />
        <script src={`${AGENT_URL}/agent.js`} data-site="nextcart" data-server={AGENT_URL} async />
      </body>
    </html>
  );
}
