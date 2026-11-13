import Link from "next/link";
import { CircleHelp } from "lucide-react";

export function GuideHelpLink({
    href,
    children,
}: {
    href: string;
    children: React.ReactNode;
}) {
    return (
        <Link
            href={href}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex min-h-11 items-center gap-1.5 rounded text-sm underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:outline-none"
        >
            <CircleHelp aria-hidden="true" className="size-4 shrink-0" />
            {children}
        </Link>
    );
}
