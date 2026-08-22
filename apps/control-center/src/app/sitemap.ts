import type { MetadataRoute } from "next";
import { MARKETING_PAGES, readSeoConfig } from "@/lib/seo";

export const dynamic = "force-dynamic";

export default function sitemap(): MetadataRoute.Sitemap {
    const { origin, indexingEnabled } = readSeoConfig();

    if (!indexingEnabled) return [];

    return MARKETING_PAGES.map((path) => ({
        url: new URL(path, `${origin}/`).toString(),
    }));
}
