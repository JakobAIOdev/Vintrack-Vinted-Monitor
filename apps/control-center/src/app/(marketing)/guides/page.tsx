import Link from "next/link";
import {
    ArrowRight,
    Bell,
    BookOpen,
    LifeBuoy,
    MonitorDot,
    UserRound,
} from "lucide-react";
import { GuideHeader } from "@/components/guides/guide-content";
import { GUIDE_TOPICS, guideHref } from "@/lib/guides";
import { buildMarketingMetadata } from "@/lib/seo";
import { BreadcrumbJsonLd } from "@/components/marketing/marketing-page";

export function generateMetadata() {
    return buildMarketingMetadata({
        title: "Vinted Monitor Guides & Help | Vintrack",
        description:
            "Learn how to set up Vinted monitors, connect Discord and Telegram alerts, track price drops, and troubleshoot missing matches with Vintrack's step-by-step guides.",
        path: "/guides",
    });
}

const icons = [BookOpen, MonitorDot, Bell, UserRound, LifeBuoy];

export default function PublicGuidesPage() {
    return (
        <main className="mx-auto max-w-6xl space-y-8 px-4 py-10 sm:px-6 sm:py-14">
            <BreadcrumbJsonLd name="Guides" path="/guides" />
            <GuideHeader placement="public" />
            <div className="grid gap-4 md:grid-cols-2">
                {GUIDE_TOPICS.map((topic, index) => {
                    const Icon = icons[index];
                    return (
                        <section
                            key={topic.slug}
                            className={`bg-card text-card-foreground border-border rounded-xl border p-5 sm:p-6 ${index === 0 ? "md:col-span-2" : ""}`}
                        >
                            <Icon
                                aria-hidden="true"
                                className="text-muted-foreground size-5"
                            />
                            <h2 className="mt-4 text-xl font-semibold">
                                <Link
                                    className="underline-offset-4 hover:underline"
                                    href={guideHref("public", topic.slug)}
                                >
                                    {topic.title}
                                </Link>
                            </h2>
                            <p className="text-muted-foreground mt-2 max-w-2xl text-sm leading-7">
                                {topic.description}
                            </p>
                            <ul className="mt-4 space-y-1">
                                {topic.articles.map((article) => (
                                    <li key={article.id}>
                                        <Link
                                            href={guideHref(
                                                "public",
                                                topic.slug,
                                                article.id,
                                            )}
                                            className="text-muted-foreground hover:text-foreground inline-flex min-h-11 items-center gap-2 text-sm underline-offset-4 hover:underline"
                                        >
                                            {article.title}
                                            <ArrowRight
                                                aria-hidden="true"
                                                className="size-3.5 shrink-0"
                                            />
                                        </Link>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    );
                })}
            </div>
        </main>
    );
}
