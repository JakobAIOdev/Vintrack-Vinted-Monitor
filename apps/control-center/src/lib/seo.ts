import type { Metadata } from "next";
import { connection } from "next/server";

export const MARKETING_PAGES = [
    "/",
    "/vinted-alerts",
    "/vinted-price-tracker",
    "/self-hosted-vinted-monitor",
] as const;

const FALLBACK_ORIGIN = "http://localhost:3000";

export type SeoConfig = {
    origin: string;
    indexingEnabled: boolean;
};

function normalizePublicOrigin(value: string | undefined) {
    if (!value?.trim()) return null;

    try {
        const url = new URL(value.trim());
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            return null;
        }
        if (
            url.username ||
            url.password ||
            url.pathname !== "/" ||
            url.search ||
            url.hash
        ) {
            return null;
        }
        return url.origin;
    } catch {
        return null;
    }
}

export function readSeoConfig(): SeoConfig {
    const configuredOrigin = normalizePublicOrigin(process.env.APP_PUBLIC_URL);

    return {
        origin: configuredOrigin ?? FALLBACK_ORIGIN,
        indexingEnabled:
            process.env.SEO_INDEXING_ENABLED === "true" &&
            configuredOrigin !== null,
    };
}

export async function buildMarketingMetadata({
    title,
    description,
    path,
}: {
    title: string;
    description: string;
    path: (typeof MARKETING_PAGES)[number];
}): Promise<Metadata> {
    // Public Docker images receive APP_PUBLIC_URL when the container starts,
    // so metadata must not be frozen during the image build.
    await connection();

    const { origin, indexingEnabled } = readSeoConfig();
    const canonical = new URL(path, `${origin}/`).toString();
    const socialImage = new URL("/opengraph-image", `${origin}/`).toString();

    return {
        metadataBase: new URL(origin),
        title,
        description,
        alternates: {
            canonical,
        },
        robots: {
            index: indexingEnabled,
            follow: indexingEnabled,
        },
        openGraph: {
            type: "website",
            locale: "en_US",
            siteName: "Vintrack",
            title,
            description,
            url: canonical,
            images: [
                {
                    url: socialImage,
                    width: 1200,
                    height: 630,
                    alt: "Vintrack Vinted monitoring dashboard",
                },
            ],
        },
        twitter: {
            card: "summary_large_image",
            title,
            description,
            images: [socialImage],
        },
    };
}

export function absoluteMarketingUrl(path: (typeof MARKETING_PAGES)[number]) {
    const { origin } = readSeoConfig();
    return new URL(path, `${origin}/`).toString();
}
