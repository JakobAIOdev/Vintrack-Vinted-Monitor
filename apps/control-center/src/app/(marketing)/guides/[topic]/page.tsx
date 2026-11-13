import Link from "next/link";
import { notFound } from "next/navigation";
import { GuideContent, GuideHeader } from "@/components/guides/guide-content";
import { GUIDE_SLUGS, getGuideTopic } from "@/lib/guides";
import { absoluteMarketingUrl, buildMarketingMetadata } from "@/lib/seo";

type Props = { params: Promise<{ topic: string }> };

export function generateStaticParams() {
    return GUIDE_SLUGS.map((topic) => ({ topic }));
}

export async function generateMetadata({ params }: Props) {
    const topic = getGuideTopic((await params).topic);
    if (!topic) notFound();
    return buildMarketingMetadata({
        title: `${topic.title} | Vintrack`,
        description: topic.description,
        path: `/guides/${topic.slug}`,
    });
}

export default async function PublicGuideTopicPage({ params }: Props) {
    const topic = getGuideTopic((await params).topic);
    if (!topic) notFound();
    const breadcrumbs = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: [
            {
                "@type": "ListItem",
                position: 1,
                name: "Home",
                item: absoluteMarketingUrl("/"),
            },
            {
                "@type": "ListItem",
                position: 2,
                name: "Guides",
                item: absoluteMarketingUrl("/guides"),
            },
            {
                "@type": "ListItem",
                position: 3,
                name: topic.label,
                item: absoluteMarketingUrl(`/guides/${topic.slug}`),
            },
        ],
    };
    return (
        <main className="mx-auto max-w-6xl space-y-7 px-4 py-10 sm:px-6 sm:py-14">
            <script
                type="application/ld+json"
                dangerouslySetInnerHTML={{
                    __html: JSON.stringify(breadcrumbs).replace(
                        /</g,
                        "\\u003c",
                    ),
                }}
            />
            <nav
                aria-label="Breadcrumb"
                className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm"
            >
                <Link
                    href="/guides"
                    className="underline-offset-4 hover:underline"
                >
                    Guides
                </Link>
                <span aria-hidden="true">/</span>
                <span aria-current="page">{topic.label}</span>
            </nav>
            <GuideHeader placement="public" topic={topic} />
            <GuideContent placement="public" topic={topic} />
        </main>
    );
}
