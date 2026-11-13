import Link from "next/link";
import Image from "next/image";
import { ArrowRight, BookOpen, CheckCircle2, Info, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CreateMonitorLink } from "@/components/maintenance/create-monitor-link";
import { GuideNavigation } from "@/components/guides/guide-navigation";
import {
    GUIDE_TOPICS,
    guideHref,
    type GuidePlacement,
    type GuideTopic,
    type GuideArticle,
} from "@/lib/guides";

function GuideScreenshot({
    image,
    title,
}: {
    image: NonNullable<GuideArticle["image"]>;
    title: string;
}) {
    const variants = [
        { src: image.src, theme: "light", className: "block dark:hidden" },
        { src: image.darkSrc, theme: "dark", className: "hidden dark:block" },
    ];
    return (
        <figure className="border-border bg-muted/20 mt-6 overflow-hidden rounded-xl border">
            {variants.map((variant) => (
                <a
                    key={variant.theme}
                    href={variant.src}
                    data-screenshot-theme={variant.theme}
                    className={variant.className}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Enlarge screenshot: ${title}`}
                >
                    <Image
                        src={variant.src}
                        alt={image.alt}
                        width={image.width}
                        height={image.height}
                        className="h-auto w-full"
                        sizes="(max-width: 1024px) 100vw, 800px"
                    />
                </a>
            ))}
            <figcaption className="text-muted-foreground border-border border-t px-4 py-3 text-xs leading-6">
                {image.caption}
            </figcaption>
        </figure>
    );
}

function GuideAction({
    action,
    placement,
}: {
    action: NonNullable<GuideArticle["action"]>;
    placement: GuidePlacement;
}) {
    if (placement === "public")
        return (
            <Button asChild variant="outline">
                <Link href="/login">
                    Open Vintrack{" "}
                    <ArrowRight aria-hidden="true" className="size-4" />
                </Link>
            </Button>
        );
    return (
        <Button asChild variant="outline">
            {action.href === "/monitors/new" ? (
                <CreateMonitorLink>
                    {action.label}
                    <ArrowRight aria-hidden="true" className="size-4" />
                </CreateMonitorLink>
            ) : (
                <Link href={action.href}>
                    {action.label}
                    <ArrowRight aria-hidden="true" className="size-4" />
                </Link>
            )}
        </Button>
    );
}

export function GuideHeader({
    placement,
    topic,
}: {
    placement: GuidePlacement;
    topic?: GuideTopic;
}) {
    return (
        <>
            <header className="flex flex-col items-start justify-between gap-5 sm:flex-row">
                <div className="max-w-3xl">
                    <p className="text-muted-foreground flex items-center gap-2 text-xs font-medium">
                        <BookOpen aria-hidden="true" className="size-4" />{" "}
                        Vintrack help center
                    </p>
                    <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
                        {placement === "app"
                            ? "Guides"
                            : (topic?.title ?? "Vinted monitoring guides")}
                    </h1>
                    <p className="text-muted-foreground mt-3 text-sm leading-7 sm:text-base">
                        {placement === "app"
                            ? "Set up your first monitor, connect alerts, or find the answer you need."
                            : (topic?.description ??
                              "Practical instructions for Vinted monitors, Discord and Telegram alerts, Price Watches, and linked-account features.")}
                    </p>
                </div>
                {placement === "app" && (
                    <Button asChild className="shrink-0">
                        <CreateMonitorLink>
                            Create monitor
                            <ArrowRight aria-hidden="true" className="size-4" />
                        </CreateMonitorLink>
                    </Button>
                )}
            </header>
            <GuideNavigation
                items={GUIDE_TOPICS.map((item) => ({
                    label: item.label,
                    href: guideHref(placement, item.slug),
                    active: item.slug === topic?.slug,
                }))}
            />
        </>
    );
}

export function GuideContent({
    topic,
    placement,
}: {
    topic: GuideTopic;
    placement: GuidePlacement;
}) {
    const ArticleHeading = placement === "app" ? "h3" : "h2";
    const contents = (
        <ul className="space-y-1">
            {topic.articles.map((article) => (
                <li key={article.id}>
                    <a
                        href={`#${article.id}`}
                        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring block rounded-md px-2 py-2.5 text-sm leading-5 focus-visible:ring-2 focus-visible:outline-none"
                    >
                        {article.title}
                    </a>
                </li>
            ))}
        </ul>
    );
    return (
        <div className="grid items-start gap-7 lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-10">
            <aside className="min-w-0 lg:sticky lg:top-24">
                <div className="hidden lg:block">
                    <p className="mb-3 px-2 text-xs font-semibold">
                        In this guide
                    </p>
                    {contents}
                </div>
                <details className="border-border rounded-lg border lg:hidden">
                    <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
                        On this page
                    </summary>
                    <div className="px-2 pb-2">{contents}</div>
                </details>
            </aside>
            <div className="min-w-0">
                {placement === "app" && (
                    <div className="mb-7">
                        <h2 className="text-2xl font-semibold tracking-tight">
                            {topic.title}
                        </h2>
                        <p className="text-muted-foreground mt-2 text-sm leading-7">
                            {topic.description}
                        </p>
                    </div>
                )}
                <div className="divide-border divide-y">
                    {topic.articles.map((article) => (
                        <article
                            id={article.id}
                            key={article.id}
                            aria-labelledby={`${article.id}-title`}
                            className="scroll-mt-24 py-8 first:pt-0 last:pb-0"
                        >
                            <div className="flex items-start justify-between gap-3">
                                <ArticleHeading
                                    id={`${article.id}-title`}
                                    className="text-xl font-semibold tracking-tight"
                                >
                                    {article.title}
                                </ArticleHeading>
                                <a
                                    href={`#${article.id}`}
                                    aria-label={`Link to ${article.title}`}
                                    className="text-muted-foreground hover:text-foreground focus-visible:ring-ring -mt-2 flex size-11 shrink-0 items-center justify-center rounded-md focus-visible:ring-2 focus-visible:outline-none"
                                >
                                    <Link2
                                        aria-hidden="true"
                                        className="size-4"
                                    />
                                </a>
                            </div>
                            <p className="text-muted-foreground mt-2 max-w-3xl text-sm leading-7">
                                {article.summary}
                            </p>
                            <ol className="mt-6 space-y-5">
                                {article.steps.map((step, index) => (
                                    <li
                                        key={step.title}
                                        className="grid grid-cols-[28px_minmax(0,1fr)] gap-3"
                                    >
                                        <span
                                            aria-hidden="true"
                                            className="bg-muted text-foreground flex size-7 items-center justify-center rounded-full text-xs font-semibold tabular-nums"
                                        >
                                            {index + 1}
                                        </span>
                                        <div>
                                            <p className="pt-0.5 text-sm font-semibold">
                                                {step.title}
                                            </p>
                                            <p className="text-muted-foreground mt-1 text-sm leading-7">
                                                {step.detail}
                                            </p>
                                        </div>
                                    </li>
                                ))}
                            </ol>
                            {article.image && (
                                <GuideScreenshot
                                    image={article.image}
                                    title={article.title}
                                />
                            )}
                            {article.note && (
                                <div className="bg-muted/40 mt-6 flex items-start gap-2.5 rounded-lg p-4">
                                    <Info
                                        aria-hidden="true"
                                        className="text-muted-foreground mt-0.5 size-4 shrink-0"
                                    />
                                    <p className="text-muted-foreground text-sm leading-6">
                                        {article.note}
                                    </p>
                                </div>
                            )}
                            <div className="mt-6 flex items-start gap-2.5">
                                <CheckCircle2
                                    aria-hidden="true"
                                    className="mt-0.5 size-4 shrink-0 text-emerald-700 dark:text-emerald-300"
                                />
                                <div>
                                    <p className="text-sm font-semibold">
                                        What to expect
                                    </p>
                                    <p className="text-muted-foreground mt-1 text-sm leading-7">
                                        {article.result}
                                    </p>
                                </div>
                            </div>
                            <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3">
                                {article.action && (
                                    <GuideAction
                                        action={article.action}
                                        placement={placement}
                                    />
                                )}
                                {article.related?.map((link) => (
                                    <Link
                                        key={`${link.topic}-${link.article}`}
                                        href={guideHref(
                                            placement,
                                            link.topic,
                                            link.article,
                                        )}
                                        className="text-muted-foreground hover:text-foreground inline-flex min-h-11 items-center gap-1.5 rounded text-sm underline-offset-4 hover:underline"
                                    >
                                        {link.label}
                                        <ArrowRight
                                            aria-hidden="true"
                                            className="size-3.5"
                                        />
                                    </Link>
                                ))}
                            </div>
                        </article>
                    ))}
                </div>
                <div className="border-border mt-10 flex flex-wrap items-center justify-between gap-3 border-t pt-5 text-sm">
                    <p className="text-muted-foreground">Still need a hand?</p>
                    <a
                        href="https://discord.gg/WbEpEjaWjP"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex min-h-11 items-center gap-2 font-medium underline-offset-4 hover:underline"
                    >
                        Ask in the Vintrack community
                        <ArrowRight aria-hidden="true" className="size-4" />
                    </a>
                </div>
            </div>
        </div>
    );
}
