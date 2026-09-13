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
    if (required.length > 0) {
        throw new Error(
            `Invalid production configuration. Missing or conflicting variables: ${required.join(", ")}`,
        );
    }
}
