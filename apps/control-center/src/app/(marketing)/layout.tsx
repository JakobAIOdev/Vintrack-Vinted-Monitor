import {
    MarketingFooter,
    MarketingHeader,
} from "@/components/marketing/marketing-shell";

export default function MarketingLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <div className="bg-background text-foreground min-h-screen">
            <MarketingHeader />
            {children}
            <MarketingFooter />
        </div>
    );
}
