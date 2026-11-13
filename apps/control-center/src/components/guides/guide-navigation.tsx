"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

export function GuideNavigation({
    items,
}: {
    items: { label: string; href: string; active: boolean }[];
}) {
    const router = useRouter();
    return (
        <div>
            <div className="md:hidden">
                <label
                    htmlFor="guide-topic"
                    className="text-muted-foreground mb-2 block text-xs font-medium"
                >
                    Guide topic
                </label>
                <select
                    id="guide-topic"
                    value={items.find((item) => item.active)?.href ?? ""}
                    onChange={(event) => router.push(event.target.value)}
                    className="border-input bg-background text-foreground focus-visible:ring-ring min-h-11 w-full rounded-lg border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
                >
                    <option value="" disabled>
                        Choose a topic
                    </option>
                    {items.map((item) => (
                        <option key={item.href} value={item.href}>
                            {item.label}
                        </option>
                    ))}
                </select>
            </div>
            <nav
                aria-label="Guide topics"
                className="border-border hidden flex-wrap gap-x-6 border-b md:flex"
            >
                {items.map((item) => (
                    <Link
                        key={item.href}
                        href={item.href}
                        aria-current={item.active ? "page" : undefined}
                        className={cn(
                            "focus-visible:ring-ring -mb-px inline-flex min-h-12 items-center border-b-2 px-1 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none",
                            item.active
                                ? "border-foreground text-foreground"
                                : "text-muted-foreground hover:text-foreground border-transparent",
                        )}
                    >
                        {item.label}
                    </Link>
                ))}
            </nav>
        </div>
    );
}
