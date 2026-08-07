"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    MAX_MONITOR_ANTI_KEYWORDS_COUNT,
    MAX_MONITOR_ANTI_KEYWORDS_LENGTH,
    MAX_MONITOR_ANTI_KEYWORD_LENGTH,
    parseMonitorAntiKeywords,
} from "@/lib/monitor-anti-keywords";
import { Plus, X } from "lucide-react";
import {
    useMemo,
    useState,
    type ClipboardEvent,
    type KeyboardEvent,
} from "react";

type AntiKeywordInputProps = {
    name: string;
    defaultValue?: string | null;
    onCountChange?: (count: number) => void;
};

export function AntiKeywordInput({
    name,
    defaultValue,
    onCountChange,
}: AntiKeywordInputProps) {
    const [keywords, setKeywords] = useState<string[]>(() =>
        parseMonitorAntiKeywords(defaultValue || ""),
    );
    const [draft, setDraft] = useState("");

    const serialized = useMemo(() => keywords.join(","), [keywords]);
    const exceedsLimit =
        keywords.length > MAX_MONITOR_ANTI_KEYWORDS_COUNT ||
        serialized.length > MAX_MONITOR_ANTI_KEYWORDS_LENGTH ||
        keywords.some(
            (keyword) => keyword.length > MAX_MONITOR_ANTI_KEYWORD_LENGTH,
        );

    const addKeywords = (value: string) => {
        const next = parseMonitorAntiKeywords(value);
        if (next.length === 0) return;

        const seen = new Set(keywords.map((keyword) => keyword.toLowerCase()));
        const merged = [...keywords];
        for (const keyword of next) {
            const key = keyword.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(keyword);
        }
        setKeywords(merged);
        onCountChange?.(merged.length);
        setDraft("");
    };

    const removeKeyword = (keyword: string) => {
        const remaining = keywords.filter(
            (currentKeyword) =>
                currentKeyword.toLowerCase() !== keyword.toLowerCase(),
        );
        setKeywords(remaining);
        onCountChange?.(remaining.length);
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key !== "Enter" && event.key !== ",") return;

        event.preventDefault();
        addKeywords(draft);
    };

    const handlePaste = (event: ClipboardEvent<HTMLInputElement>) => {
        const text = event.clipboardData.getData("text");
        if (!/[,\n\r]/.test(text)) return;

        event.preventDefault();
        addKeywords(`${draft}${text}`);
    };

    return (
        <div className="space-y-2">
            <input type="hidden" name={name} value={serialized} />
            <div className="flex gap-2">
                <Input
                    id={name}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={handleKeyDown}
                    onPaste={handlePaste}
                    maxLength={MAX_MONITOR_ANTI_KEYWORD_LENGTH}
                    placeholder="e.g. damaged, fake, replica"
                    className="flex-1"
                />
                <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => addKeywords(draft)}
                    disabled={!draft.trim()}
                    title="Add anti keyword"
                    aria-label="Add anti keyword"
                >
                    <Plus className="h-4 w-4" />
                </Button>
            </div>
            <p
                className={`text-[11px] ${
                    exceedsLimit ? "text-destructive" : "text-muted-foreground"
                }`}
            >
                {keywords.length} / {MAX_MONITOR_ANTI_KEYWORDS_COUNT} anti
                keywords · {serialized.length} /{" "}
                {MAX_MONITOR_ANTI_KEYWORDS_LENGTH} characters
            </p>
            {keywords.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                    {keywords.map((keyword) => (
                        <Badge
                            key={keyword.toLowerCase()}
                            variant="outline"
                            className="gap-1.5 py-1 pr-1"
                        >
                            <span>{keyword}</span>
                            <button
                                type="button"
                                onClick={() => removeKeyword(keyword)}
                                className="text-muted-foreground hover:text-foreground inline-flex h-4 w-4 items-center justify-center rounded-full transition-colors"
                                aria-label={`Remove ${keyword}`}
                                title={`Remove ${keyword}`}
                            >
                                <X className="h-3 w-3" />
                            </button>
                        </Badge>
                    ))}
                </div>
            )}
        </div>
    );
}
