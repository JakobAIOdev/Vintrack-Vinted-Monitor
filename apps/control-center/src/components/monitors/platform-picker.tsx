"use client";

import {
    type ChangeEvent,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { Check, Loader2, Search, X } from "lucide-react";
import {
    matchesVideoGamePlatform,
    VIDEO_GAME_PLATFORMS,
    VIDEO_GAME_PLATFORM_CATALOG_ID,
    type VideoGamePlatform,
} from "@/lib/video-game-platforms";

interface PlatformPickerProps {
    selected: string[];
    onChange: (ids: string[]) => void;
    region: string;
    catalogIds?: string[];
}

const PLATFORM_CACHE_KEY = "vintrack.video-game-platform-cache.v1";

function mergePlatforms(...groups: ReadonlyArray<ReadonlyArray<VideoGamePlatform>>) {
    const byId = new Map<string, VideoGamePlatform>();
    for (const group of groups) {
        for (const platform of group) {
            byId.set(platform.id, platform);
        }
    }
    return [...byId.values()].sort((a, b) =>
        a.label.localeCompare(b.label),
    );
}

function platformIdsFromVintedUrl(value: string) {
    try {
        const url = new URL(value);
        if (!url.hostname.includes("vinted.")) return [];

        const keys = [
            "video_game_platform_ids[]",
            "video_game_platform_ids",
            "platform_ids[]",
            "platform_ids",
        ];
        const ids = keys.flatMap((key) => url.searchParams.getAll(key));
        const pathMatch = url.pathname.match(/\/platforms?\/(\d+)(?:-|\/|$)/i);
        if (pathMatch?.[1]) ids.push(pathMatch[1]);
        return ids.filter((id) => /^\d+$/.test(id));
    } catch {
        return [];
    }
}

export function PlatformPicker({
    selected,
    onChange,
    region,
    catalogIds = [],
}: PlatformPickerProps) {
    const [query, setQuery] = useState("");
    const [open, setOpen] = useState(false);
    const [remotePlatforms, setRemotePlatforms] = useState<
        VideoGamePlatform[]
    >([]);
    const [cachedPlatforms, setCachedPlatforms] = useState<
        VideoGamePlatform[]
    >([]);
    const [loadingRemote, setLoadingRemote] = useState(false);
    const [remoteError, setRemoteError] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        function handleClick(event: MouseEvent) {
            if (ref.current && !ref.current.contains(event.target as Node)) {
                setOpen(false);
            }
        }
        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, []);

    useEffect(() => {
        try {
            const cached = JSON.parse(
                localStorage.getItem(PLATFORM_CACHE_KEY) || "[]",
            );
            if (Array.isArray(cached)) {
                setCachedPlatforms(
                    cached.filter(
                        (platform): platform is VideoGamePlatform =>
                            typeof platform?.id === "string" &&
                            typeof platform?.label === "string",
                    ),
                );
            }
        } catch {
            setCachedPlatforms([]);
        }
    }, []);

    const localPlatforms = useMemo(
        () => mergePlatforms(VIDEO_GAME_PLATFORMS, cachedPlatforms),
        [cachedPlatforms],
    );

    useEffect(() => {
        const normalizedQuery = query.trim();
        if (
            normalizedQuery.length < 2 ||
            normalizedQuery.startsWith("http") ||
            localPlatforms.some((platform) =>
                matchesVideoGamePlatform(platform, normalizedQuery),
            )
        ) {
            setRemotePlatforms([]);
            setLoadingRemote(false);
            setRemoteError(false);
            return;
        }

        const controller = new AbortController();
        const timeout = window.setTimeout(async () => {
            setLoadingRemote(true);
            setRemoteError(false);

            const params = new URLSearchParams({
                query: normalizedQuery,
                region,
                catalog_ids:
                    catalogIds.length > 0
                        ? catalogIds.join(",")
                        : VIDEO_GAME_PLATFORM_CATALOG_ID,
            });

            try {
                const response = await fetch(
                    `/api/catalog/platforms?${params.toString()}`,
                    { cache: "no-store", signal: controller.signal },
                );
                const data = await response.json();
                if (!response.ok) {
                    throw new Error(data?.error || "Platform search failed");
                }

                if (!controller.signal.aborted) {
                    setRemotePlatforms(
                        (Array.isArray(data.platforms)
                            ? data.platforms
                            : []
                        ).filter(
                            (
                                platform: unknown,
                            ): platform is VideoGamePlatform =>
                                typeof (platform as VideoGamePlatform)?.id ===
                                    "string" &&
                                typeof (platform as VideoGamePlatform)?.label ===
                                    "string",
                        ),
                    );
                }
            } catch {
                if (!controller.signal.aborted) {
                    setRemotePlatforms([]);
                    setRemoteError(true);
                }
            } finally {
                if (!controller.signal.aborted) {
                    setLoadingRemote(false);
                }
            }
        }, 250);

        return () => {
            controller.abort();
            window.clearTimeout(timeout);
        };
    }, [catalogIds, localPlatforms, query, region]);

    const allPlatforms = useMemo(
        () => mergePlatforms(VIDEO_GAME_PLATFORMS, cachedPlatforms, remotePlatforms),
        [cachedPlatforms, remotePlatforms],
    );
    const manualPlatform = useMemo(
        () =>
            /^\d+$/.test(query.trim()) &&
            !allPlatforms.some((platform) => platform.id === query.trim())
                ? {
                      id: query.trim(),
                      label: `Platform #${query.trim()}`,
                  }
                : null,
        [allPlatforms, query],
    );
    const filtered = useMemo(() => {
        const normalizedQuery = query.trim();
        const matches = normalizedQuery
            ? allPlatforms.filter((platform) =>
                  matchesVideoGamePlatform(platform, normalizedQuery),
              )
            : allPlatforms;
        return mergePlatforms(matches, manualPlatform ? [manualPlatform] : []);
    }, [allPlatforms, manualPlatform, query]);
    const selectedPlatforms = selected.map(
        (id) =>
            allPlatforms.find((platform) => platform.id === id) ?? {
                id,
                label: `Platform #${id}`,
            },
    );

    const remember = (platform: VideoGamePlatform) => {
        setCachedPlatforms((current) => {
            const next = mergePlatforms(current, [platform]).slice(0, 200);
            try {
                localStorage.setItem(
                    PLATFORM_CACHE_KEY,
                    JSON.stringify(next),
                );
            } catch {}
            return next;
        });
    };

    const toggle = (platform: VideoGamePlatform) => {
        if (selected.includes(platform.id)) {
            onChange(selected.filter((id) => id !== platform.id));
            return;
        }
        remember(platform);
        onChange([...selected, platform.id]);
        setQuery("");
    };

    const handleQueryChange = (event: ChangeEvent<HTMLInputElement>) => {
        const value = event.target.value;
        const pastedIds = platformIdsFromVintedUrl(value);
        if (pastedIds.length > 0) {
            onChange([...new Set([...selected, ...pastedIds])]);
            setQuery("");
            setOpen(false);
            return;
        }
        setQuery(value);
        setOpen(true);
    };

    return (
        <div ref={ref} className="relative">
            {selectedPlatforms.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                    {selectedPlatforms.map((platform) => (
                        <span
                            key={platform.id}
                            className="bg-primary text-primary-foreground border-primary inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[12px] font-medium"
                        >
                            {platform.label}
                            <button
                                type="button"
                                onClick={() =>
                                    onChange(
                                        selected.filter(
                                            (id) => id !== platform.id,
                                        ),
                                    )
                                }
                                aria-label={`Remove ${platform.label}`}
                            >
                                <X className="h-3 w-3" />
                            </button>
                        </span>
                    ))}
                </div>
            )}

            <div className="relative">
                <Search className="text-muted-foreground absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2" />
                <input
                    type="text"
                    value={query}
                    onChange={handleQueryChange}
                    onFocus={() => setOpen(true)}
                    placeholder="Search platform (PS2, PS5, Switch…)"
                    className="border-input bg-background focus:border-border h-9 w-full rounded-md border pr-3 pl-8 text-[13px] transition-colors outline-none focus:ring-2 focus:ring-slate-900/10"
                />
            </div>

            {open && (
                <div className="border-input bg-background absolute z-50 mt-1 max-h-52 w-full overflow-y-auto rounded-md border shadow-lg">
                    {filtered.length === 0 ? (
                        <div className="text-muted-foreground px-3 py-2 text-[13px]">
                            {loadingRemote
                                ? "Searching Vinted..."
                                : remoteError
                                  ? "Platform search unavailable"
                                  : "No platform found"}
                        </div>
                    ) : (
                        <>
                            {filtered.map((platform) => {
                                const isSelected = selected.includes(
                                    platform.id,
                                );
                                return (
                                    <button
                                        key={platform.id}
                                        type="button"
                                        onClick={() => toggle(platform)}
                                        className="hover:bg-muted flex w-full items-center justify-between px-3 py-1.5 text-left text-[13px] transition-colors"
                                    >
                                        <span>{platform.label}</span>
                                        {isSelected && (
                                            <Check className="text-primary h-3 w-3" />
                                        )}
                                    </button>
                                );
                            })}
                            {loadingRemote && (
                                <div className="border-border text-muted-foreground flex items-center gap-2 border-t px-3 py-2 text-[12px]">
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    Searching Vinted...
                                </div>
                            )}
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
