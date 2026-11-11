"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
    ArrowLeft,
    ChevronLeft,
    ChevronRight,
    HandCoins,
    Inbox,
    Loader2,
    MessageCircle,
    ReceiptText,
    RefreshCw,
    Send,
    XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useVintedAccount } from "@/components/account-provider";
import { cn } from "@/lib/utils";

type InboxConversation = {
    id: number;
    item_count?: number;
    description?: string;
    unread?: boolean;
    updated_at?: string;
    opposite_user?: {
        id?: number;
        login?: string;
        photo?: { url?: string | null } | null;
    } | null;
    item_photos?: Array<{ id?: number; url?: string | null }> | null;
};

type InboxPagination = {
    current_page: number;
    total_pages: number;
    total_entries: number;
};

type ChatReply = {
    id: string;
    body: string;
    createdAt: string | null;
    userId: number | null;
    login: string;
    avatarUrl: string | null;
    isOwn: boolean;
    isSystem: boolean;
};

type ThreadMeta = {
    kind: "offer" | "declined" | "accepted" | "counter" | "info";
    title: string;
    description: string;
    amount?: string | null;
};

type JsonRecord = Record<string, unknown>;

function toNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function toStringValue(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): JsonRecord | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    return value as JsonRecord;
}

function pickReplyArray(payload: unknown): unknown[] {
    const root = asRecord(payload);
    const conversation = asRecord(root?.conversation);
    const data = asRecord(root?.data);

    const candidates = [
        conversation?.messages,
        root?.replies,
        root?.messages,
        root?.conversation_messages,
        conversation?.replies,
        data?.replies,
        data?.messages,
    ];

    const found = candidates.find(Array.isArray);
    return Array.isArray(found) ? found : [];
}

function normalizeReplies(payload: unknown): ChatReply[] {
    const root = asRecord(payload);
    const currentUserId = toNumber(root?.current_user_id);

    return pickReplyArray(payload)
        .map((raw: unknown, index: number): ChatReply | null => {
            const rawRecord = asRecord(raw);
            const entity = asRecord(rawRecord?.entity);
            const replyRecord = asRecord(rawRecord?.reply);
            const user =
                asRecord(rawRecord?.user) ??
                asRecord(rawRecord?.sender) ??
                asRecord(rawRecord?.author) ??
                asRecord(replyRecord?.user);
            const userPhoto = asRecord(user?.photo);
            const userAvatar = asRecord(user?.avatar);
            const userId =
                toNumber(user?.id) ??
                toNumber(entity?.user_id) ??
                toNumber(rawRecord?.user_id) ??
                toNumber(rawRecord?.sender_id) ??
                toNumber(rawRecord?.author_id);
            const body =
                toStringValue(entity?.body) ||
                toStringValue(rawRecord?.body) ||
                toStringValue(rawRecord?.message) ||
                toStringValue(rawRecord?.text) ||
                toStringValue(rawRecord?.content) ||
                toStringValue(replyRecord?.body);

            const createdAt =
                toStringValue(rawRecord?.created_at_ts) ||
                toStringValue(rawRecord?.created_at) ||
                toStringValue(rawRecord?.updated_at) ||
                toStringValue(rawRecord?.sent_at) ||
                null;

            const login =
                toStringValue(user?.login) ||
                toStringValue(user?.name) ||
                (userId === currentUserId ? "You" : "Vinted user");

            const avatarUrl =
                toStringValue(userPhoto?.url) ||
                toStringValue(userAvatar?.url) ||
                null;

            const id =
                toStringValue(entity?.id) ||
                toStringValue(rawRecord?.id) ||
                toStringValue(rawRecord?.uuid) ||
                `${userId ?? "reply"}-${createdAt ?? index}`;

            if (!body && !rawRecord?.is_system && !rawRecord?.system_message) {
                return null;
            }

            return {
                id,
                body: body || "System message",
                createdAt,
                userId,
                login,
                avatarUrl,
                isOwn: currentUserId !== null && userId === currentUserId,
                isSystem: Boolean(
                    rawRecord?.is_system || rawRecord?.system_message,
                ),
            };
        })
        .filter((reply): reply is ChatReply => Boolean(reply))
        .sort((a, b) => {
            const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
            const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
            return aTime - bTime;
        });
}

function classifyOfferState(text: string): ThreadMeta["kind"] {
    const normalized = text.toLowerCase();
    if (normalized.includes("abgelehnt") || normalized.includes("declined")) {
        return "declined";
    }
    if (normalized.includes("angenommen") || normalized.includes("accepted")) {
        return "accepted";
    }
    if (normalized.includes("gegenangebot") || normalized.includes("counter")) {
        return "counter";
    }
    if (normalized.includes("angebot") || normalized.includes("offer")) {
        return "offer";
    }
    return "info";
}

function extractThreadMeta(payload: unknown): ThreadMeta | null {
    const root = asRecord(payload);
    const conversation = asRecord(root?.conversation);
    const transaction = asRecord(conversation?.transaction);
    const offerPrice = asRecord(transaction?.offer_price);
    const subtitle = toStringValue(conversation?.subtitle);
    const amount = toStringValue(offerPrice?.amount);
    const currency = toStringValue(offerPrice?.currency_code);

    const description =
        subtitle ||
        (amount ? `Offer in this thread: ${amount} ${currency}` : "");
    if (!description && !amount) {
        return null;
    }

    const kind = classifyOfferState(description);

    if (kind === "info" && !amount) {
        return null;
    }

    return {
        kind,
        title:
            kind === "declined"
                ? "Offer Declined"
                : kind === "accepted"
                  ? "Offer Accepted"
                  : kind === "counter"
                    ? "Counter Offer"
                    : "Offer Activity",
        description,
        amount: amount ? `${amount} ${currency}`.trim() : null,
    };
}

function formatThreadTime(value?: string | null) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return value;
    }
    return new Intl.DateTimeFormat("de-DE", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    }).format(date);
}

function formatConversationTime(value?: string) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return value;
    }
    return new Intl.DateTimeFormat("de-DE", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    }).format(date);
}

export function ChatsClient() {
    const { linked, loading: accountLoading } = useVintedAccount();
    const [conversations, setConversations] = useState<InboxConversation[]>([]);
    const [pagination, setPagination] = useState<InboxPagination | null>(null);
    const [page, setPage] = useState(1);
    const [selectedConversationId, setSelectedConversationId] = useState<
        number | null
    >(null);
    const [replies, setReplies] = useState<ChatReply[]>([]);
    const [inboxLoading, setInboxLoading] = useState(true);
    const [threadLoading, setThreadLoading] = useState(false);
    const [sending, setSending] = useState(false);
    const [message, setMessage] = useState("");
    const [threadMeta, setThreadMeta] = useState<ThreadMeta | null>(null);
    const [mobileThreadOpen, setMobileThreadOpen] = useState(false);
    const selectedConversationIdRef = useRef<number | null>(null);

    const selectedConversation = useMemo(
        () =>
            conversations.find(
                (conversation) => conversation.id === selectedConversationId,
            ) ?? null,
        [conversations, selectedConversationId],
    );

    useEffect(() => {
        selectedConversationIdRef.current = selectedConversationId;
    }, [selectedConversationId]);

    const fetchInbox = useCallback(
        async (pageNum: number, keepSelection = true) => {
            setInboxLoading(true);
            try {
                const res = await fetch(
                    `/api/messages/inbox?page=${pageNum}&per_page=25`,
                    {
                        cache: "no-store",
                    },
                );
                const data = await res.json();
                if (!res.ok) {
                    throw new Error(
                        data.error || `Failed to load inbox (${res.status})`,
                    );
                }

                const nextConversations = Array.isArray(data.conversations)
                    ? data.conversations
                    : [];
                setConversations(nextConversations);

                if (data.pagination) {
                    setPagination({
                        current_page: Number(
                            data.pagination.current_page || pageNum,
                        ),
                        total_pages: Number(data.pagination.total_pages || 1),
                        total_entries: Number(
                            data.pagination.total_entries ||
                                nextConversations.length,
                        ),
                    });
                } else {
                    setPagination(null);
                }

                if (nextConversations.length === 0) {
                    setSelectedConversationId(null);
                    setMobileThreadOpen(false);
                    setReplies([]);
                    return;
                }

                const currentSelection = selectedConversationIdRef.current;
                if (
                    keepSelection &&
                    currentSelection &&
                    nextConversations.some(
                        (item: InboxConversation) =>
                            item.id === currentSelection,
                    )
                ) {
                    return;
                }

                setSelectedConversationId(nextConversations[0].id);
            } catch (error) {
                console.error(error);
                toast.error(
                    error instanceof Error
                        ? error.message
                        : "Failed to load chats",
                );
            } finally {
                setInboxLoading(false);
            }
        },
        [],
    );

    const fetchConversation = useCallback(async (conversationId: number) => {
        setThreadLoading(true);
        try {
            const res = await fetch(
                `/api/messages/conversations/${conversationId}?page=1&per_page=100`,
                {
                    cache: "no-store",
                },
            );
            const data = await res.json();
            if (!res.ok) {
                throw new Error(
                    data.error || `Failed to load chat (${res.status})`,
                );
            }

            setThreadMeta(extractThreadMeta(data));
            setReplies(normalizeReplies(data));
        } catch (error) {
            console.error(error);
            setThreadMeta(null);
            setReplies([]);
            toast.error(
                error instanceof Error ? error.message : "Failed to load chat",
            );
        } finally {
            setThreadLoading(false);
        }
    }, []);

    useEffect(() => {
        if (linked) {
            void fetchInbox(page, false);
        }
    }, [fetchInbox, linked, page]);

    useEffect(() => {
        if (selectedConversationId) {
            void fetchConversation(selectedConversationId);
        }
    }, [fetchConversation, selectedConversationId]);

    async function handleSendReply() {
        if (!linked) {
            toast.error("Link your Vinted account first (Account tab)");
            return;
        }
        if (!selectedConversationId) {
            toast.error("Choose a chat first");
            return;
        }

        const trimmed = message.trim();
        if (!trimmed) {
            return;
        }

        setSending(true);
        try {
            const res = await fetch("/api/messages/reply", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    conversation_id: selectedConversationId,
                    message: trimmed,
                }),
            });

            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.error || `Reply failed (${res.status})`);
            }

            setMessage("");
            await Promise.all([
                fetchConversation(selectedConversationId),
                fetchInbox(page),
            ]);
            toast.success("Reply sent");
        } catch (error) {
            console.error(error);
            toast.error(
                error instanceof Error ? error.message : "Failed to send reply",
            );
        } finally {
            setSending(false);
        }
    }

    const unreadCount = conversations.filter(
        (conversation) => conversation.unread,
    ).length;
    const selectedImageUrl =
        selectedConversation?.item_photos?.[0]?.url ||
        selectedConversation?.opposite_user?.photo?.url ||
        null;

    if (accountLoading) {
        return (
            <div className="space-y-5">
                <div className="space-y-2">
                    <div className="bg-muted h-8 w-28 animate-pulse rounded-md" />
                    <div className="bg-muted h-4 w-72 animate-pulse rounded-md" />
                </div>
                <div className="border-border/80 bg-card grid h-[calc(100dvh-11.5rem)] min-h-144 overflow-hidden rounded-xl border lg:grid-cols-[21rem_minmax(0,1fr)]">
                    <div className="border-border/70 border-r">
                        <div className="border-border/70 h-16 border-b" />
                        <div className="space-y-1 p-2">
                            {Array.from({ length: 6 }).map((_, index) => (
                                <div
                                    key={index}
                                    className="bg-muted h-17 animate-pulse rounded-lg"
                                />
                            ))}
                        </div>
                    </div>
                    <div className="hidden lg:block">
                        <div className="border-border/70 h-16 border-b" />
                    </div>
                </div>
            </div>
        );
    }

    if (!linked) {
        return (
            <div className="flex h-[60vh] flex-col items-center justify-center px-4 text-center">
                <div className="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-full bg-blue-500/10 text-blue-500">
                    <MessageCircle className="h-8 w-8" />
                </div>
                <h2 className="text-2xl font-semibold tracking-tight">
                    Vinted Account Not Linked
                </h2>
                <p className="text-muted-foreground mt-1.5 max-w-sm">
                    Connect your Vinted account to view your inbox and answer
                    chats directly from Vintrack.
                </p>
                <Button asChild className="mt-6">
                    <Link href="/account">Go to Account Settings</Link>
                </Button>
            </div>
        );
    }

    return (
        <div className="space-y-5">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight">Chats</h1>
                    <p className="text-muted-foreground mt-0.5 text-sm">
                        {pagination
                            ? `${pagination.total_entries} conversation${pagination.total_entries === 1 ? "" : "s"} in your Vinted inbox${unreadCount > 0 ? ` · ${unreadCount} unread` : ""}.`
                            : "Read and reply to your Vinted conversations."}
                    </p>
                </div>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void fetchInbox(page)}
                    disabled={inboxLoading}
                    className="shrink-0 gap-1.5"
                >
                    <RefreshCw
                        className={cn(
                            "h-3.5 w-3.5",
                            inboxLoading && "animate-spin",
                        )}
                    />
                    <span className="hidden sm:inline">Refresh</span>
                </Button>
            </div>

            <div className="border-border/80 bg-card grid h-[calc(100dvh-11.5rem)] max-h-192 min-h-144 overflow-hidden rounded-xl border lg:grid-cols-[21rem_minmax(0,1fr)]">
                <aside
                    className={cn(
                        "min-h-0 flex-col lg:flex lg:border-r",
                        mobileThreadOpen ? "hidden" : "flex",
                    )}
                >
                    <div className="border-border/70 flex h-16 shrink-0 items-center justify-between border-b px-4">
                        <div>
                            <p className="text-sm font-semibold">Inbox</p>
                            <p className="text-muted-foreground text-xs">
                                {pagination?.total_entries ??
                                    conversations.length}{" "}
                                total
                            </p>
                        </div>
                        {unreadCount > 0 && (
                            <span className="bg-primary text-primary-foreground rounded-full px-2 py-0.5 text-[11px] font-semibold">
                                {unreadCount} new
                            </span>
                        )}
                    </div>

                    <div className="min-h-0 flex-1 overflow-y-auto">
                        {inboxLoading && conversations.length === 0 ? (
                            <div className="space-y-1 p-2">
                                {Array.from({ length: 6 }).map((_, index) => (
                                    <div
                                        key={index}
                                        className="bg-muted h-17 animate-pulse rounded-lg"
                                    />
                                ))}
                            </div>
                        ) : conversations.length > 0 ? (
                            <div className="divide-border/60 divide-y">
                                {conversations.map((conversation) => {
                                    const active =
                                        conversation.id ===
                                        selectedConversationId;
                                    const imageUrl =
                                        conversation.item_photos?.[0]?.url ||
                                        conversation.opposite_user?.photo
                                            ?.url ||
                                        null;

                                    return (
                                        <button
                                            key={conversation.id}
                                            type="button"
                                            onClick={() => {
                                                setSelectedConversationId(
                                                    conversation.id,
                                                );
                                                setMobileThreadOpen(true);
                                            }}
                                            className={cn(
                                                "hover:bg-muted/60 focus-visible:bg-muted flex w-full gap-3 px-4 py-3 text-left transition-colors outline-none",
                                                active && "bg-accent/70",
                                            )}
                                        >
                                            <div className="bg-muted relative h-12 w-12 shrink-0 overflow-hidden rounded-lg">
                                                {imageUrl ? (
                                                    <img
                                                        src={imageUrl}
                                                        alt={
                                                            conversation.description ||
                                                            conversation
                                                                .opposite_user
                                                                ?.login ||
                                                            "Conversation"
                                                        }
                                                        className="h-full w-full object-cover"
                                                    />
                                                ) : (
                                                    <div className="text-muted-foreground flex h-full w-full items-center justify-center">
                                                        <Inbox className="h-4 w-4" />
                                                    </div>
                                                )}
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-center gap-2">
                                                    <p
                                                        className={cn(
                                                            "min-w-0 flex-1 truncate text-sm",
                                                            conversation.unread
                                                                ? "font-semibold"
                                                                : "font-medium",
                                                        )}
                                                    >
                                                        @
                                                        {conversation
                                                            .opposite_user
                                                            ?.login ||
                                                            "unknown"}
                                                    </p>
                                                    <span className="text-muted-foreground shrink-0 text-[10px]">
                                                        {formatConversationTime(
                                                            conversation.updated_at,
                                                        )}
                                                    </span>
                                                </div>
                                                <div className="mt-1 flex items-center gap-2">
                                                    <p className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                                                        {conversation.description ||
                                                            "Open conversation"}
                                                    </p>
                                                    {conversation.unread && (
                                                        <span className="bg-primary h-2 w-2 shrink-0 rounded-full" />
                                                    )}
                                                </div>
                                                <p className="text-muted-foreground/70 mt-1 text-[10px]">
                                                    {conversation.item_count ||
                                                        0}{" "}
                                                    {conversation.item_count ===
                                                    1
                                                        ? "item"
                                                        : "items"}
                                                </p>
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
                                <Inbox className="text-muted-foreground/50 mb-3 h-7 w-7" />
                                <p className="text-sm font-medium">
                                    No chats found
                                </p>
                                <p className="text-muted-foreground mt-1 max-w-xs text-xs leading-5">
                                    Your Vinted conversations will appear here.
                                </p>
                            </div>
                        )}
                    </div>

                    {pagination && pagination.total_pages > 1 && (
                        <div className="border-border/70 flex h-14 shrink-0 items-center justify-between border-t px-3">
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label="Previous inbox page"
                                onClick={() =>
                                    setPage((current) =>
                                        Math.max(1, current - 1),
                                    )
                                }
                                disabled={page <= 1 || inboxLoading}
                            >
                                <ChevronLeft className="h-4 w-4" />
                            </Button>
                            <span className="text-muted-foreground text-xs">
                                {page} / {pagination.total_pages}
                            </span>
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label="Next inbox page"
                                onClick={() =>
                                    setPage((current) =>
                                        Math.min(
                                            pagination.total_pages,
                                            current + 1,
                                        ),
                                    )
                                }
                                disabled={
                                    page >= pagination.total_pages ||
                                    inboxLoading
                                }
                            >
                                <ChevronRight className="h-4 w-4" />
                            </Button>
                        </div>
                    )}
                </aside>

                <section
                    className={cn(
                        "min-h-0 flex-col lg:flex",
                        mobileThreadOpen ? "flex" : "hidden",
                    )}
                >
                    <div className="border-border/70 flex h-16 shrink-0 items-center gap-3 border-b px-3 sm:px-4">
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            className="lg:hidden"
                            aria-label="Back to inbox"
                            onClick={() => setMobileThreadOpen(false)}
                        >
                            <ArrowLeft className="h-4 w-4" />
                        </Button>
                        <div className="bg-muted h-10 w-10 shrink-0 overflow-hidden rounded-lg">
                            {selectedImageUrl ? (
                                <img
                                    src={selectedImageUrl}
                                    alt={
                                        selectedConversation?.opposite_user
                                            ?.login || "Conversation"
                                    }
                                    className="h-full w-full object-cover"
                                />
                            ) : (
                                <div className="text-muted-foreground flex h-full w-full items-center justify-center">
                                    <MessageCircle className="h-4 w-4" />
                                </div>
                            )}
                        </div>
                        <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold">
                                {selectedConversation
                                    ? `@${selectedConversation.opposite_user?.login || "unknown"}`
                                    : "Conversation"}
                            </p>
                            <p className="text-muted-foreground truncate text-xs">
                                {selectedConversation?.description ||
                                    "Select a conversation from the inbox."}
                            </p>
                        </div>
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Refresh conversation"
                            onClick={() =>
                                selectedConversationId &&
                                void fetchConversation(selectedConversationId)
                            }
                            disabled={!selectedConversationId || threadLoading}
                        >
                            <RefreshCw
                                className={cn(
                                    "h-4 w-4",
                                    threadLoading && "animate-spin",
                                )}
                            />
                        </Button>
                    </div>

                    {selectedConversation ? (
                        <>
                            <div className="bg-muted/15 min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-4 sm:px-5">
                                {threadMeta && (
                                    <div className="border-border/70 bg-background mx-auto flex max-w-2xl items-start gap-3 rounded-lg border px-3 py-3">
                                        <div
                                            className={cn(
                                                "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
                                                threadMeta.kind === "declined"
                                                    ? "bg-rose-500/10 text-rose-600 dark:text-rose-400"
                                                    : threadMeta.kind ===
                                                        "accepted"
                                                      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                                      : threadMeta.kind ===
                                                          "counter"
                                                        ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                                                        : "bg-sky-500/10 text-sky-600 dark:text-sky-400",
                                            )}
                                        >
                                            {threadMeta.kind === "declined" ? (
                                                <XCircle className="h-4 w-4" />
                                            ) : threadMeta.kind ===
                                              "accepted" ? (
                                                <ReceiptText className="h-4 w-4" />
                                            ) : (
                                                <HandCoins className="h-4 w-4" />
                                            )}
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <p className="text-sm font-medium">
                                                    {threadMeta.title}
                                                </p>
                                                {threadMeta.amount && (
                                                    <span className="bg-muted rounded-md px-1.5 py-0.5 text-[11px] font-medium">
                                                        {threadMeta.amount}
                                                    </span>
                                                )}
                                            </div>
                                            <p className="text-muted-foreground mt-0.5 text-xs leading-5">
                                                {threadMeta.description}
                                            </p>
                                        </div>
                                    </div>
                                )}

                                {threadLoading && replies.length === 0 ? (
                                    <div className="space-y-3">
                                        {Array.from({ length: 5 }).map(
                                            (_, index) => (
                                                <div
                                                    key={index}
                                                    className={cn(
                                                        "bg-muted h-16 max-w-[75%] animate-pulse rounded-2xl",
                                                        index % 2 === 0
                                                            ? "mr-auto"
                                                            : "ml-auto",
                                                    )}
                                                />
                                            ),
                                        )}
                                    </div>
                                ) : replies.length > 0 ? (
                                    replies.map((reply) => (
                                        <div
                                            key={reply.id}
                                            className={cn(
                                                "flex",
                                                reply.isOwn
                                                    ? "justify-end"
                                                    : "justify-start",
                                            )}
                                        >
                                            <div
                                                className={cn(
                                                    "max-w-[88%] sm:max-w-[75%]",
                                                    reply.isSystem &&
                                                        "mx-auto max-w-[90%] text-center",
                                                )}
                                            >
                                                {!reply.isSystem && (
                                                    <div
                                                        className={cn(
                                                            "mb-1 flex items-center gap-2 px-1 text-[10px]",
                                                            reply.isOwn &&
                                                                "justify-end",
                                                        )}
                                                    >
                                                        <span className="text-muted-foreground font-medium">
                                                            {reply.isOwn
                                                                ? "You"
                                                                : reply.login}
                                                        </span>
                                                        {reply.createdAt && (
                                                            <span className="text-muted-foreground/70">
                                                                {formatThreadTime(
                                                                    reply.createdAt,
                                                                )}
                                                            </span>
                                                        )}
                                                    </div>
                                                )}
                                                <div
                                                    className={cn(
                                                        "px-3.5 py-2.5 text-sm leading-6",
                                                        reply.isSystem
                                                            ? "bg-muted text-muted-foreground rounded-lg text-xs"
                                                            : reply.isOwn
                                                              ? "bg-primary text-primary-foreground rounded-2xl rounded-br-md"
                                                              : "border-border/70 bg-background rounded-2xl rounded-bl-md border",
                                                    )}
                                                >
                                                    <p className="wrap-break-words whitespace-pre-wrap">
                                                        {reply.body}
                                                    </p>
                                                </div>
                                            </div>
                                        </div>
                                    ))
                                ) : (
                                    <div className="flex h-full min-h-64 flex-col items-center justify-center text-center">
                                        <MessageCircle className="text-muted-foreground/40 mb-3 h-7 w-7" />
                                        <p className="text-sm font-medium">
                                            No messages loaded
                                        </p>
                                        <p className="text-muted-foreground mt-1 max-w-sm text-xs leading-5">
                                            This Vinted conversation did not
                                            return any readable messages yet.
                                        </p>
                                    </div>
                                )}
                            </div>

                            <div className="border-border/70 bg-card shrink-0 border-t p-3 sm:p-4">
                                <textarea
                                    value={message}
                                    onChange={(event) =>
                                        setMessage(event.target.value)
                                    }
                                    placeholder="Write a reply"
                                    rows={2}
                                    className="border-input bg-background placeholder:text-muted-foreground focus:border-ring focus:ring-ring/20 min-h-18 w-full resize-none rounded-lg border px-3 py-2.5 text-sm transition outline-none focus:ring-2"
                                    maxLength={2000}
                                />
                                <div className="mt-2 flex items-center justify-between gap-3">
                                    <p className="text-muted-foreground text-[11px]">
                                        {message.trim().length}/2000
                                    </p>
                                    <Button
                                        size="sm"
                                        onClick={() => void handleSendReply()}
                                        disabled={sending || !message.trim()}
                                        className="gap-1.5"
                                    >
                                        {sending ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                            <Send className="h-3.5 w-3.5" />
                                        )}
                                        Send
                                    </Button>
                                </div>
                            </div>
                        </>
                    ) : (
                        <div className="flex min-h-0 flex-1 items-center justify-center px-6">
                            <div className="max-w-sm text-center">
                                <MessageCircle className="text-muted-foreground/40 mx-auto mb-3 h-8 w-8" />
                                <p className="text-sm font-medium">
                                    Choose a conversation
                                </p>
                                <p className="text-muted-foreground mt-1 text-xs leading-5">
                                    Select a chat from the inbox to view the
                                    thread and send a reply.
                                </p>
                            </div>
                        </div>
                    )}
                </section>
            </div>
        </div>
    );
}
