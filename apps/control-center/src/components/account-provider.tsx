"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

type AccountContextType = {
  linked: boolean;
  loading: boolean;
  likedIds: Set<number>;
  addLike: (id: number) => void;
  removeLike: (id: number) => void;
};

const AccountContext = createContext<AccountContextType>({
  linked: false,
  loading: true,
  likedIds: new Set(),
  addLike: () => {},
  removeLike: () => {},
});

export function AccountProvider({ children }: { children: React.ReactNode }) {
  const [linked, setLinked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [likedIds, setLikedIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    fetch("/api/account")
      .then((res) => res.json())
      .then((data) => {
        const isLinked = data.linked === true;
        setLinked(isLinked);
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
      .catch(() => setLinked(false))
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

  return (
    <AccountContext.Provider value={{ linked, loading, likedIds, addLike, removeLike }}>
      {children}
    </AccountContext.Provider>
  );
}

export function useVintedAccount() {
  return useContext(AccountContext);
}
