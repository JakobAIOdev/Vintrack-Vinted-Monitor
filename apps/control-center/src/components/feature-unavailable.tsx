import Link from "next/link";
import { LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    FEATURE_DEFINITION_BY_KEY,
    type FeatureAccessResult,
} from "@/lib/features";

export function FeatureUnavailable({
    access,
}: {
    access: Exclude<FeatureAccessResult, { allowed: true }>;
}) {
    const feature = FEATURE_DEFINITION_BY_KEY[access.feature];
    const message =
        access.reason === "role_denied"
            ? "This feature is not available for your current role."
            : access.reason === "dependency_disabled"
              ? "A required feature is currently unavailable."
              : "This feature is currently disabled by an administrator.";

    return (
        <div className="mx-auto flex min-h-[55vh] max-w-xl items-center justify-center">
            <div className="border-border/70 bg-card w-full rounded-2xl border p-8 text-center shadow-sm">
                <div className="bg-muted mx-auto flex size-12 items-center justify-center rounded-xl">
                    <LockKeyhole className="text-muted-foreground size-5" />
                </div>
                <h1 className="mt-4 text-xl font-semibold">
                    {feature.label} is unavailable
                </h1>
                <p className="text-muted-foreground mt-2 text-sm">{message}</p>
                <Button asChild className="mt-6">
                    <Link href="/dashboard">Back to dashboard</Link>
                </Button>
            </div>
        </div>
    );
}
