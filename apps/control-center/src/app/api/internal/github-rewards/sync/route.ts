import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runGithubRewardsSync } from "@/lib/github-rewards-sync.server";
import { db } from "@/lib/db";
import { getGithubRewardsPolicy } from "@/lib/github-rewards.server";

function authorized(authorization: string | null, secret: string | undefined) {
    if (!secret || !authorization) return false;
    const expected = Buffer.from(`Bearer ${secret}`);
    const actual = Buffer.from(authorization);
    return (
        expected.length === actual.length && timingSafeEqual(expected, actual)
    );
}

export async function POST(request: Request) {
    const secret = process.env.GITHUB_REWARDS_SYNC_SECRET?.trim();
    if (!authorized(request.headers.get("authorization"), secret)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    try {
        const [policy, lastJob] = await Promise.all([
            getGithubRewardsPolicy(),
            db.github_reward_jobs.findFirst({
                where: { job_type: "full_sync" },
                orderBy: { started_at: "desc" },
                select: {
                    status: true,
                    started_at: true,
                    completed_at: true,
                },
            }),
        ]);
        if (!policy.integrationEnabled) {
            return NextResponse.json({
                ok: true,
                skipped: "integration-disabled",
            });
        }
        if (lastJob) {
            const lastAttemptAt = lastJob.completed_at ?? lastJob.started_at;
            const retryMinutes =
                lastJob.status === "failed"
                    ? Math.max(policy.syncIntervalMinutes, 60)
                    : policy.syncIntervalMinutes;
            if (Date.now() - lastAttemptAt.getTime() < retryMinutes * 60_000) {
                return NextResponse.json({
                    ok: true,
                    skipped:
                        lastJob.status === "failed"
                            ? "failed-backoff"
                            : "not-due",
                });
            }
        }
        const result = await runGithubRewardsSync("scheduler");
        return NextResponse.json({ ok: true, ...result });
    } catch (error) {
        console.error("[github-rewards] scheduled sync failed", error);
        return NextResponse.json({ error: "Sync failed" }, { status: 500 });
    }
}
