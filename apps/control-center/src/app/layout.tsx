import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
    metadataBase: new URL("http://localhost:3000"),
    title: "Vintrack",
    description: "Open-source Vinted monitoring and fast listing alerts.",
    robots: {
        index: false,
        follow: false,
    },
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en" suppressHydrationWarning>
            <body className={`${inter.className} min-h-screen antialiased`}>
                <ThemeProvider>
                    {children}
                    <Toaster position="top-right" richColors />
                </ThemeProvider>
            </body>
        </html>
    );
}
