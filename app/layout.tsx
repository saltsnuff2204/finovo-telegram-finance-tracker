import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = { title: "Мои финансы", description: "Личный учёт доходов, расходов, долгов и целей в Telegram", icons: { icon: "/favicon.svg" } };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="ru"><body className="antialiased"><Script src="https://telegram.org/js/telegram-web-app.js?63" strategy="beforeInteractive"/>{children}</body></html>; }
