import { FeaturePageGate } from "@/components/feature-page-gate";

export default function FeatureLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <FeaturePageGate feature="your_listings">{children}</FeaturePageGate>
    );
}
