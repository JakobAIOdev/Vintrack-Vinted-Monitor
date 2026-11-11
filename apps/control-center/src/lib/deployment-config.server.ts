import "server-only";

import { buildDeploymentConfigDiagnostics } from "@/lib/deployment-config";

export type { DeploymentConfigDiagnostics } from "@/lib/deployment-config";

export function getDeploymentConfigDiagnostics() {
    return buildDeploymentConfigDiagnostics(process.env);
}

export function assertControlCenterProductionConfig() {
    if (
        process.env.NODE_ENV !== "production" ||
        process.env.NEXT_PHASE === "phase-production-build"
    )
        return;
    const diagnostics = getDeploymentConfigDiagnostics();
    const required = ["AUTH_URL", "AUTH_SECRET"].filter(
        (key) => !process.env[key]?.trim(),
    );
    if (diagnostics.originConflict) required.push("AUTH_URL_CONFLICT");
    // E2E mode signs every request in as an admin. It exists for local test
    // stacks only, so it must never start behind a public origin.
    if (
        process.env.E2E_TEST_MODE === "true" &&
        !isLoopbackOrigin(process.env.AUTH_URL)
    )
        required.push("E2E_TEST_MODE_ON_PUBLIC_ORIGIN");
    if (required.length > 0) {
        throw new Error(
            `Invalid production configuration. Missing or conflicting variables: ${required.join(", ")}`,
        );
    }
}

function isLoopbackOrigin(value: string | undefined) {
    try {
        const { hostname } = new URL(value?.trim() || "");
        return (
            hostname === "localhost" ||
            hostname === "127.0.0.1" ||
            hostname === "[::1]"
        );
    } catch {
        return false;
    }
}
