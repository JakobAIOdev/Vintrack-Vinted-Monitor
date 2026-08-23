import type { NextConfig } from "next";
import pkg from "./package.json";

const parsedBuildCpus = Number.parseInt(process.env.NEXT_BUILD_CPUS ?? "", 10);
const buildCpus = Number.isFinite(parsedBuildCpus) && parsedBuildCpus > 0
    ? parsedBuildCpus
    : undefined;

const nextConfig: NextConfig = {
    output: "standalone",
    distDir: process.env.NEXT_DIST_DIR ?? ".next",
    images: {
        remotePatterns: [
            {
                protocol: "https",
                hostname: "images1.vinted.net",
            },
            {
                protocol: "https",
                hostname: "images2.vinted.net",
            },
        ],
    },
    env: {
        NEXT_PUBLIC_APP_VERSION: pkg.version,
    },
    ...(buildCpus ? { experimental: { cpus: buildCpus } } : {}),
};

export default nextConfig;
