type GithubStargazer = {
    id?: number;
    login?: string;
};

type GithubStarredRepository = {
    full_name?: string;
};

/**
 * Pages of a member's starred list to scan before giving up. The list is
 * ordered by most recently starred first, so a star the member just added is
 * on the first page; the cap only matters for accounts with huge star lists.
 */
const MAX_STARRED_PAGES = 50;

function request(url: string, token: string | null, init?: RequestInit) {
    return fetch(url, {
        ...init,
        headers: {
            Accept: "application/vnd.github+json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "Vintrack-GitHub-Rewards",
            ...init?.headers,
        },
        cache: "no-store",
    });
}

export async function githubFetch<T>(
    label: string,
    url: string,
    token: string,
    init?: RequestInit & {
        /**
         * Set for endpoints that serve public data. Fine-grained tokens are
         * routinely valid while still being rejected (403) on public listings
         * such as stargazers, so the call is retried anonymously rather than
         * failing the whole sync.
         */
        publicFallback?: boolean;
    },
) {
    let response = await request(url, token, init);
    if (
        init?.publicFallback &&
        (response.status === 401 || response.status === 403)
    ) {
        response = await request(url, null, init);
    }
    if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
            message?: unknown;
        } | null;
        const detail =
            typeof body?.message === "string"
                ? `: ${body.message.slice(0, 300)}`
                : "";
        throw new Error(
            `GitHub ${label} API request failed (${response.status})${detail}`,
        );
    }
    return (await response.json()) as T;
}

/**
 * Reads the full stargazer list of the reward repository, mapping each GitHub
 * account id to its current login. Cost is `stars / 100` requests for the whole
 * instance, independent of how many members are linked.
 *
 * This is the fast path, but it is not always available: GitHub rejects this
 * endpoint for fine-grained personal access tokens (403) and, since it began
 * requiring authentication on public listings, for anonymous callers (401).
 * Callers must fall back to `hasUserStarredRepository` when it throws.
 *
 * Throws when the snapshot could not be completed; callers must never
 * downgrade anyone to "unstarred" from a partial list.
 */
export async function fetchStargazers(
    token: string,
    policy: { repositoryOwner: string; repositoryName: string },
) {
    const stargazers = new Map<string, string | null>();
    for (let page = 1; page <= 400; page += 1) {
        const rows = await githubFetch<GithubStargazer[]>(
            "Repository stargazers",
            `https://api.github.com/repos/${encodeURIComponent(policy.repositoryOwner)}/${encodeURIComponent(policy.repositoryName)}/stargazers?per_page=100&page=${page}`,
            token,
        );
        for (const row of rows) {
            if (typeof row.id === "number") {
                stargazers.set(String(row.id), row.login ?? null);
            }
        }
        if (rows.length < 100) return stargazers;
    }
    throw new Error("GitHub stargazer pagination incomplete");
}

/**
 * Checks a single member's public starred list. Unlike the repository-wide
 * snapshot this works with fine-grained tokens and even anonymously, which is
 * why it is the fallback whenever `fetchStargazers` is refused.
 *
 * Throws when the list could not be read to the end without finding the
 * repository — the caller must then keep the previous state rather than
 * recording an unstar it cannot prove.
 */
export async function hasUserStarredRepository(
    token: string,
    login: string,
    policy: { repositoryOwner: string; repositoryName: string },
) {
    const target =
        `${policy.repositoryOwner}/${policy.repositoryName}`.toLowerCase();
    for (let page = 1; page <= MAX_STARRED_PAGES; page += 1) {
        const rows = await githubFetch<GithubStarredRepository[]>(
            "User stars",
            `https://api.github.com/users/${encodeURIComponent(login)}/starred?per_page=100&page=${page}`,
            token,
            // Fine-grained tokens can be valid while lacking access to public
            // user activity, so this retries the public data anonymously.
            { publicFallback: true },
        );
        if (rows.some((row) => row.full_name?.toLowerCase() === target)) {
            return true;
        }
        if (rows.length < 100) return false;
    }
    throw new Error(`GitHub star list too long to verify for ${login}`);
}
