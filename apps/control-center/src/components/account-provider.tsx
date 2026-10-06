"use client";

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useState,
} from "react";

type AccountContextType = {
    linked: boolean;
    checkoutEnabled: boolean;
    loading: boolean;
    domain: string | null;
    likedIds: Set<number>;
    addLike: (id: number) => void;
    removeLike: (id: number) => void;
    syncLikes: (ids: number[]) => void;
};

const AccountContext = createContext<AccountContextType>({
    linked: false,
    checkoutEnabled: false,
    loading: true,
    domain: null,
    likedIds: new Set(),
    addLike: () => {},
    removeLike: () => {},
    syncLikes: () => {},
});

export function AccountProvider({
    children,
    checkoutEnabled = false,
}: {
    children: React.ReactNode;
    checkoutEnabled?: boolean;
}) {
    const [linked, setLinked] = useState(false);
    const [loading, setLoading] = useState(true);
    const [domain, setDomain] = useState<string | null>(null);
    const [likedIds, setLikedIds] = useState<Set<number>>(new Set());

    useEffect(() => {
        fetch("/api/account")
            .then((res) => res.json())
            .then((data) => {
                const isLinked = data.linked === true;
                setLinked(isLinked);
                setDomain(
                    isLinked && typeof data.domain === "string"
                        ? data.domain
                        : null,
                );
                if (isLinked) {
                    fetch("/api/items/liked")
                        .then((res) => res.json())
                        .then((data) => {
                            if (Array.isArray(data.item_ids)) {
                                setLikedIds(new Set(data.item_ids));
                            }
                        })
                        .catch(() => {});
                }
            })
            .catch(() => {
                setLinked(false);
                setDomain(null);
            })
            .finally(() => setLoading(false));
    }, []);

    const addLike = useCallback((id: number) => {
        setLikedIds((prev) => new Set(prev).add(id));
    }, []);

    const removeLike = useCallback((id: number) => {
        setLikedIds((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
        });
    }, []);

    const syncLikes = useCallback((ids: number[]) => {
        setLikedIds((prev) => {
            const next = new Set(prev);
            let changed = false;
            ids.forEach((id) => {
                if (!next.has(id)) {
                    next.add(id);
                    changed = true;
                }
            });
            return changed ? next : prev;
        });
    }, []);

    return (
        <AccountContext.Provider
            value={{
                linked,
                checkoutEnabled,
                loading,
                domain,
                likedIds,
                addLike,
                removeLike,
                syncLikes,
            }}
        >
            {children}
        </AccountContext.Provider>
    );
}

export function useVintedAccount() {
    return useContext(AccountContext);
}
