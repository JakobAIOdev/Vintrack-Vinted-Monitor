"use client";

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import type { ItemData } from "@/components/monitors/item-card";
import {
    closeBrowserAlertSound,
    playBrowserAlertSound,
    unlockBrowserAlertSound,
} from "@/lib/browser-alert-sound";

const SOUND_ENABLED_STORAGE_KEY = "vintrack.browserAlerts.enabled";
const LAST_PLAYED_STORAGE_KEY = "vintrack.browserAlerts.lastPlayedAt";
const SOUND_LOCK_NAME = "vintrack.browserAlerts.playback";
const SOUND_COOLDOWN_MS = 2000;
const SEEN_ITEM_TTL_MS = 10 * 60 * 1000;
const MAX_SEEN_ITEMS = 2000;

type MonitorStreamListener = (item: ItemData) => void;

type MonitorStreamContextValue = {
    soundEnabled: boolean;
    soundReady: boolean;
    subscribe: (listener: MonitorStreamListener) => () => void;
    toggleSound: () => Promise<void>;
};

const MonitorStreamContext = createContext<MonitorStreamContextValue | null>(
    null,
);

function readStorage(key: string) {
    try {
        return window.localStorage.getItem(key);
    } catch {
        return null;
    }
}

function writeStorage(key: string, value: string) {
    try {
        window.localStorage.setItem(key, value);
    } catch {
        // Sound still works in the current tab when storage is unavailable.
    }
}

function isStreamItem(value: unknown): value is ItemData {
    if (!value || typeof value !== "object") return false;

    const item = value as Partial<ItemData>;
    return (
        (typeof item.id === "string" || typeof item.id === "number") &&
        typeof item.monitor_id === "number" &&
        Number.isInteger(item.monitor_id)
    );
}

export function MonitorStreamProvider({
    children,
}: {
    children: React.ReactNode;
}) {
    const pathname = usePathname();
    const listenersRef = useRef(new Set<MonitorStreamListener>());
    const seenSoundItemsRef = useRef(new Map<string, number>());
    const lastPlayedAtRef = useRef(0);
    const soundEnabledRef = useRef(false);
    const soundReadyRef = useRef(false);
    const [soundEnabled, setSoundEnabled] = useState(false);
    const [soundReady, setSoundReady] = useState(false);

    const updateSoundEnabled = useCallback((enabled: boolean) => {
        soundEnabledRef.current = enabled;
        setSoundEnabled(enabled);
    }, []);

    const updateSoundReady = useCallback((ready: boolean) => {
        soundReadyRef.current = ready;
        setSoundReady(ready);
    }, []);

    const subscribe = useCallback((listener: MonitorStreamListener) => {
        listenersRef.current.add(listener);
        return () => listenersRef.current.delete(listener);
    }, []);

    const playIfCooldownAllows = useCallback(() => {
        if (!soundEnabledRef.current || !soundReadyRef.current) return;

        const now = Date.now();
        const storedLastPlayedAt = Number(readStorage(LAST_PLAYED_STORAGE_KEY));
        const lastPlayedAt = Math.max(
            lastPlayedAtRef.current,
            Number.isFinite(storedLastPlayedAt) ? storedLastPlayedAt : 0,
        );

        if (now - lastPlayedAt < SOUND_COOLDOWN_MS) return;

        if (playBrowserAlertSound()) {
            lastPlayedAtRef.current = now;
            writeStorage(LAST_PLAYED_STORAGE_KEY, String(now));
        }
    }, []);

    const playItemAlert = useCallback(
        (item: ItemData) => {
            const now = Date.now();
            const itemId = String(item.id);
            const seenItems = seenSoundItemsRef.current;
            const seenAt = seenItems.get(itemId);

            if (seenAt && now - seenAt < SEEN_ITEM_TTL_MS) return;

            seenItems.set(itemId, now);
            if (seenItems.size > MAX_SEEN_ITEMS) {
                const cutoff = now - SEEN_ITEM_TTL_MS;
                for (const [id, timestamp] of seenItems) {
                    if (timestamp < cutoff || seenItems.size > MAX_SEEN_ITEMS) {
                        seenItems.delete(id);
                    }
                    if (seenItems.size <= MAX_SEEN_ITEMS) break;
                }
            }

            if (!soundEnabledRef.current || !soundReadyRef.current) return;

            if (navigator.locks?.request) {
                void navigator.locks.request(
                    SOUND_LOCK_NAME,
                    { ifAvailable: true },
                    (lock) => {
                        if (lock) playIfCooldownAllows();
                    },
                );
                return;
            }

            playIfCooldownAllows();
        },
        [playIfCooldownAllows],
    );

    const activateSound = useCallback(
        async (playPreview: boolean) => {
            const ready = await unlockBrowserAlertSound();
            updateSoundReady(ready);

            if (!ready) return false;
            if (playPreview) playBrowserAlertSound();
            return true;
        },
        [updateSoundReady],
    );

    const toggleSound = useCallback(async () => {
        if (soundEnabledRef.current && soundReadyRef.current) {
            updateSoundEnabled(false);
            updateSoundReady(false);
            writeStorage(SOUND_ENABLED_STORAGE_KEY, "false");
            await closeBrowserAlertSound();
            return;
        }

        const ready = await activateSound(true);
        if (!ready) {
            updateSoundEnabled(false);
            writeStorage(SOUND_ENABLED_STORAGE_KEY, "false");
            toast.error(
                "Browser audio is unavailable. Check this site's sound permissions.",
            );
            return;
        }

        updateSoundEnabled(true);
        writeStorage(SOUND_ENABLED_STORAGE_KEY, "true");
    }, [activateSound, updateSoundEnabled, updateSoundReady]);

    useEffect(() => {
        let active = true;

        queueMicrotask(() => {
            if (!active) return;

            const enabled = readStorage(SOUND_ENABLED_STORAGE_KEY) === "true";
            updateSoundEnabled(enabled);
            if (enabled) void activateSound(false);
        });

        return () => {
            active = false;
        };
    }, [activateSound, updateSoundEnabled]);

    useEffect(() => {
        if (!soundEnabled || soundReady) return;

        const unlock = () => void activateSound(false);
        document.addEventListener("pointerdown", unlock, {
            capture: true,
            once: true,
        });
        document.addEventListener("keydown", unlock, {
            capture: true,
            once: true,
        });

        return () => {
            document.removeEventListener("pointerdown", unlock, true);
            document.removeEventListener("keydown", unlock, true);
        };
    }, [activateSound, soundEnabled, soundReady]);

    useEffect(() => {
        const handleStorage = (event: StorageEvent) => {
            if (event.key !== SOUND_ENABLED_STORAGE_KEY) return;

            const enabled = event.newValue === "true";
            updateSoundEnabled(enabled);
            if (enabled) {
                void activateSound(false);
            } else {
                updateSoundReady(false);
                void closeBrowserAlertSound();
            }
        };

        window.addEventListener("storage", handleStorage);
        return () => window.removeEventListener("storage", handleStorage);
    }, [activateSound, updateSoundEnabled, updateSoundReady]);

    useEffect(() => {
        const eventSource = new EventSource("/api/stream");

        eventSource.onmessage = (event) => {
            try {
                const parsed: unknown = JSON.parse(event.data);
                if (!isStreamItem(parsed)) return;

                const item: ItemData = {
                    ...parsed,
                    id: String(parsed.id),
                };

                for (const listener of listenersRef.current) {
                    try {
                        listener(item);
                    } catch (error) {
                        console.error("Monitor stream listener error", error);
                    }
                }
                playItemAlert(item);
            } catch (error) {
                console.error("SSE parse error", error);
            }
        };

        return () => eventSource.close();
    }, [pathname, playItemAlert]);

    useEffect(
        () => () => {
            void closeBrowserAlertSound();
        },
        [],
    );

    const value = useMemo(
        () => ({
            soundEnabled,
            soundReady,
            subscribe,
            toggleSound,
        }),
        [soundEnabled, soundReady, subscribe, toggleSound],
    );

    return (
        <MonitorStreamContext.Provider value={value}>
            {children}
        </MonitorStreamContext.Provider>
    );
}

export function useMonitorStreamContext() {
    const context = useContext(MonitorStreamContext);
    if (!context) {
        throw new Error(
            "useMonitorStreamContext must be used within MonitorStreamProvider",
        );
    }
    return context;
}

export function useMonitorItemStream(listener: MonitorStreamListener) {
    const { subscribe } = useMonitorStreamContext();
    const listenerRef = useRef(listener);

    useEffect(() => {
        listenerRef.current = listener;
    }, [listener]);

    useEffect(
        () => subscribe((item) => listenerRef.current(item)),
        [subscribe],
    );
}
