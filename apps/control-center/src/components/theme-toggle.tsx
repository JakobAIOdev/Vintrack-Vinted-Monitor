"use client";

import { MoonStar, SunMedium } from "lucide-react";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";

interface ThemeToggleProps {
    className?: string;
    compact?: boolean;
}

export function ThemeToggle({ className, compact = false }: ThemeToggleProps) {
    const { resolvedTheme, setTheme } = useTheme();
    const isDark = resolvedTheme === "dark";

    return (
        <button
            type="button"
            onClick={() => setTheme(isDark ? "light" : "dark")}
            className={cn(
                "theme-toggle ui-action border-border/70 bg-background/70 text-foreground hover:bg-accent hover:text-accent-foreground inline-flex items-center border shadow-sm backdrop-blur transition-colors",
                compact
                    ? "h-8 w-8 justify-center rounded-lg"
                    : "h-9 w-full justify-between rounded-xl px-3",
                className,
            )}
            aria-label="Toggle color theme"
            title="Toggle color theme"
        >
            <span className="flex items-center gap-2">
                <SunMedium
                    aria-hidden="true"
                    className="theme-sun h-4 w-4 dark:hidden"
                />
                <MoonStar
                    aria-hidden="true"
                    className="theme-moon hidden h-4 w-4 dark:block"
                />
                {!compact && (
                    <span className="text-xs font-medium">
                        <span className="dark:hidden">Light Mode</span>
                        <span className="hidden dark:inline">Dark Mode</span>
                    </span>
                )}
            </span>
            {!compact && (
                <span className="text-muted-foreground text-[11px]">
                    <span className="dark:hidden">Off</span>
                    <span className="hidden dark:inline">On</span>
                </span>
            )}
        </button>
    );
}
