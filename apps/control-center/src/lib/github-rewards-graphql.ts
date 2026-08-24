export type GithubGraphqlError = {
    message: string;
    path?: Array<string | number>;
};

export function isIgnorableSponsorsGraphqlError(error: GithubGraphqlError) {
    if (
        /^Could not resolve to (?:an? )?(?:Organization|User) with the login of '.+'\.?$/.test(
            error.message,
        )
    ) {
        return true;
    }
    if (error.message !== "Resource not accessible by personal access token") {
        return false;
    }
    // Fine-grained tokens can list the sponsorship connection while hiding
    // either one detail field or one entire node. Process every accessible
    // node instead of failing the complete sync because of that partial data.
    const nodesIndex = error.path?.lastIndexOf("nodes") ?? -1;
    return nodesIndex >= 0 && nodesIndex < (error.path?.length ?? 0) - 1;
}
