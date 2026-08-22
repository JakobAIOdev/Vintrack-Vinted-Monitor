import type { MetadataRoute } from "next";
import { readSeoConfig } from "@/lib/seo";

export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
    const { origin, indexingEnabled } = readSeoConfig();

    if (!indexingEnabled) {
        return {
            rules: {
                userAgent: "*",
                disallow: "/",
            },
        };
    }

    return {
        rules: {
            userAgent: "*",
            allow: "/",
            disallow: "/api/",
        },
        sitemap: `${origin}/sitemap.xml`,
    };
}
