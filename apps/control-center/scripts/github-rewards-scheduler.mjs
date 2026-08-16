const endpoint =
    process.env.GITHUB_REWARDS_SYNC_URL ||
    "http://control-center:3000/api/internal/github-rewards/sync";
const secret = process.env.GITHUB_REWARDS_SYNC_SECRET || "";
const tickMs = 5 * 60 * 1000;

async function tick() {
    if (!secret) return;
    try {
        const response = await fetch(endpoint, {
            method: "POST",
            headers: { Authorization: `Bearer ${secret}` },
        });
        if (!response.ok) {
            console.error(
                `[github-rewards-scheduler] sync returned ${response.status}`,
            );
        }
    } catch (error) {
        console.error("[github-rewards-scheduler] sync request failed", error);
    }
}

await tick();
setInterval(() => void tick(), tickMs);
