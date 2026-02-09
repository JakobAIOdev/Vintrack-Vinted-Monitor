import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";


const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Vintrack Pro",
  description: "High-Performance Vinted Monitoring",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${inter.className} bg-slate-50 text-slate-900 h-screen overflow-hidden flex`}>
        <Sidebar />
        <div className="flex-1 flex flex-col min-w-0">
            <Header />
            <main className="flex-1 overflow-y-auto p-6">
                {children}
            </main>
        </div>
      </body>
    </html>
  );
}
