"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    parseVintedSearchUrl,
    type VintedSearchImport,
} from "@/lib/vinted-url";
import { CheckCircle2, Link2, WandSparkles, X } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { toast } from "sonner";

type VintedUrlImporterProps = {
    idPrefix: string;
    extraParams: string;
    onImport: (value: VintedSearchImport) => void;
    onClearExtraParams: () => void;
};

export function VintedUrlImporter({
    idPrefix,
    extraParams,
    onImport,
    onClearExtraParams,
}: VintedUrlImporterProps) {
    const [url, setUrl] = useState("");
    const [error, setError] = useState("");
    const [summary, setSummary] = useState("");
    const inputId = `${idPrefix}-vinted-search-url`;
    const extraParamsDisplay = [...new URLSearchParams(extraParams)]
        .map(([key, value]) => `${key}=${value}`)
        .join("&");

    const importUrl = () => {
        const result = parseVintedSearchUrl(url);
        if (!result.ok) {
            setSummary("");
            setError(result.error);
            return;
        }

        onImport(result.value);
        setError("");

        const summaryParts = [
            `${result.value.importedFields.join(", ")} imported`,
            ...(result.value.preservedParameterNames.length
                ? [
                      `${result.value.preservedParameterNames.length} additional ${
                          result.value.preservedParameterNames.length === 1
                              ? "filter"
                              : "filters"
                      } preserved`,
                  ]
                : []),
            ...(result.value.ignoredMetadataNames.length
                ? [
                      `${result.value.ignoredMetadataNames.length} URL metadata ${
                          result.value.ignoredMetadataNames.length === 1
                              ? "field"
                              : "fields"
                      } skipped`,
                  ]
                : []),
            ...(result.value.ignoredValueCount
                ? [
                      `${result.value.ignoredValueCount} invalid ${
                          result.value.ignoredValueCount === 1
                              ? "value"
                              : "values"
                      } ignored`,
                  ]
                : []),
        ];
        const nextSummary = `${summaryParts.join(" · ")}.`;
        setSummary(nextSummary);
        toast.success(
            `${result.value.importedFields.length} Vinted ${
                result.value.importedFields.length === 1
                    ? "setting"
                    : "settings"
            } imported`,
        );
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        importUrl();
    };

    return (
        <div
            className="border-primary/20 from-primary/5 via-background to-background rounded-xl border bg-linear-to-br p-4"
            data-testid="vinted-url-importer"
        >
            <div className="flex items-start gap-3">
                <span className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
                    <Link2 className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                    <Label
                        htmlFor={inputId}
                        className="text-[13px] font-semibold"
                    >
                        Import Vinted search
                    </Label>
                    <p className="text-muted-foreground mt-0.5 text-[12px] leading-5">
                        Paste a Vinted catalog URL to replace the region,
                        search, price, category, brand, color, condition, size,
                        and platform filters below. Additional safe Vinted
                        filters are retained automatically.
                    </p>
                </div>
            </div>

            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <Input
                    id={inputId}
                    type="url"
                    inputMode="url"
                    autoComplete="off"
                    spellCheck={false}
                    value={url}
                    onChange={(event) => {
                        setUrl(event.target.value);
                        if (error) setError("");
                        if (summary) setSummary("");
                    }}
                    onKeyDown={handleKeyDown}
                    placeholder="https://www.vinted.de/catalog?..."
                    aria-invalid={Boolean(error)}
                    aria-describedby={`${inputId}-help`}
                    className="min-w-0 flex-1"
                />
                <Button
                    type="button"
                    onClick={importUrl}
                    disabled={!url.trim()}
                    className="shrink-0 gap-2"
                    data-testid="import-vinted-url"
                >
                    <WandSparkles className="size-4" />
                    Import filters
                </Button>
            </div>

            <div id={`${inputId}-help`} className="mt-2">
                {error ? (
                    <p className="text-destructive text-[12px]" role="alert">
                        {error}
                    </p>
                ) : summary ? (
                    <p
                        className="flex items-start gap-1.5 text-[12px] text-emerald-700 dark:text-emerald-400"
                        role="status"
                        data-testid="vinted-url-import-summary"
                    >
                        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
                        <span>{summary}</span>
                    </p>
                ) : (
                    <p className="text-muted-foreground text-[11px]">
                        Alerts, proxy settings, seller quality, anti-keywords,
                        and strict item locations stay unchanged.
                    </p>
                )}
            </div>

            {extraParams && (
                <div
                    className="border-border/70 bg-background/80 mt-3 flex items-start justify-between gap-3 rounded-lg border px-3 py-2"
                    data-testid="vinted-extra-params"
                >
                    <div className="min-w-0">
                        <p className="text-foreground text-[11px] font-semibold">
                            Additional Vinted filters
                        </p>
                        <code className="text-muted-foreground mt-0.5 block text-[10px] break-all">
                            {extraParamsDisplay}
                        </code>
                    </div>
                    <button
                        type="button"
                        onClick={onClearExtraParams}
                        className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-7 shrink-0 items-center justify-center rounded-md transition-colors"
                        aria-label="Remove additional Vinted filters"
                        title="Remove additional filters"
                    >
                        <X className="size-3.5" />
                    </button>
                </div>
            )}
        </div>
    );
}
