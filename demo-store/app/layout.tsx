import type { Metadata } from "next";
import "./globals.css";
import AgentWidget from "@/components/AgentWidget";

export const metadata: Metadata = {
  title: "Dokan — demo storefront",
  description: "Demo storefront with a behavioral in-page agent",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <AgentWidget />
      </body>
    </html>
  );
}
