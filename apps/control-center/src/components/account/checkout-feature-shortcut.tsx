import Link from "next/link";
import { ArrowRight } from "lucide-react";

export function CheckoutFeatureShortcut({ linked }: { linked: boolean }) {
    return (
        <Link
            href={
                linked
                    ? "/account?connection=vinted#checkout-settings"
                    : "/account?connection=vinted#vinted-connection"
            }
            className="text-muted-foreground hover:text-foreground group mt-2 inline-flex items-center gap-2 rounded py-1 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2"
        >
            <span className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold">
                New
            </span>
            <span>
                {linked
                    ? "Pickup points & currency limits"
                    : "Link Vinted for pickup points & currency limits"}
            </span>
            <ArrowRight
                className="size-3.5 shrink-0 transition-transform group-hover:translate-x-0.5"
                aria-hidden="true"
            />
        </Link>
    );
}
