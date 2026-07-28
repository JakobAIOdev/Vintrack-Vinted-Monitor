"use client";

import { createMonitor, testDiscordWebhook } from "@/actions/monitor";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CategoryPicker } from "@/components/monitors/category-picker";
import { BrandPicker } from "@/components/monitors/brand-picker";
import { SizePicker } from "@/components/monitors/size-picker";
import { RegionPicker } from "@/components/monitors/region-picker";
import { CountryFilterPicker } from "@/components/monitors/country-filter-picker";
import { ColorPicker } from "@/components/monitors/color-picker";
import { StatusPicker } from "@/components/monitors/status-picker";
import { PlatformPicker } from "@/components/monitors/platform-picker";
import { AntiKeywordInput } from "@/components/monitors/anti-keyword-input";
import { MonitorPresetPicker } from "@/components/monitors/preset-picker";
import {
    FormSection,
    RegionPoolStatus,
    getFreeProxyRegionHealth,
    type FreeProxyOption,
} from "@/components/monitors/monitor-form-sections";
import { QuietHoursSection } from "@/components/monitors/quiet-hours-section";
import { Switch } from "@/components/ui/switch";
import { getStatusLocaleForRegionCodes } from "@/lib/regions";
import {
    DEFAULT_QUERY_DELAY_MS,
    MAX_QUERY_DELAY_MS,
    MIN_QUERY_DELAY_MS,
} from "@/lib/monitor-delay";
import { buildVintedMonitorUrl } from "@/lib/vinted-url";
import {
    MAX_MONITOR_QUERY_LENGTH,
    parseMonitorQueries,
} from "@/lib/monitor-query";
import { hasVideoGamePlatformCatalog } from "@/lib/video-game-platforms";
import {
    getMonitorPreset,
    type MonitorPreset,
    type MonitorPresetKey,
} from "@/lib/monitor-presets";
import {
    ArrowLeft,
    Bell,
    ChevronDown,
    Copy,
    Eye,
    ExternalLink,
    Network,
    Plus,
    Send,
    Settings2,
    Sparkles,
    SlidersHorizontal,
    X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
    useState,
    useEffect,
    useCallback,
    type FocusEvent,
    type FormEvent,
} from "react";
import { toast } from "sonner";

type ProxyGroupOption = {
    id: number;
    name: string;
    proxyCount: number;
};

export default function NewMonitorPage() {
    const router = useRouter();
    const [name, setName] = useState("");
    const [selectedPreset, setSelectedPreset] =
        useState<MonitorPresetKey | null>(null);
    const [presetsOpen, setPresetsOpen] = useState(true);
    const [antiKeywordResetKey, setAntiKeywordResetKey] = useState(0);
    const [selectedSizes, setSelectedSizes] = useState<string[]>([]);
    const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
    const [selectedCategoryLabels, setSelectedCategoryLabels] = useState<
        string[]
    >([]);
    const [selectedBrands, setSelectedBrands] = useState<string[]>([]);
    const [selectedColors, setSelectedColors] = useState<string[]>([]);
    const [selectedStatuses, setSelectedStatuses] = useState<string[]>([]);
    const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([]);
    const [selectedRegion, setSelectedRegion] = useState<string>("de");
    const [selectedAllowedCountries, setSelectedAllowedCountries] = useState<
        string[]
    >([]);
    const [query, setQuery] = useState("");
    const [priceMin, setPriceMin] = useState("");
    const [priceMax, setPriceMax] = useState("");
    const [proxyGroups, setProxyGroups] = useState<ProxyGroupOption[]>([]);
    const [freeProxy, setFreeProxy] = useState<FreeProxyOption>({
        enabled: false,
        activeCount: 0,
        minActivePerRegion: 25,
        regions: {},
    });
    const [userRole, setUserRole] = useState<string>("free");
    const [selectedProxyGroup, setSelectedProxyGroup] = useState<string>("");
    const [webhookUrl, setWebhookUrl] = useState<string>("");
    const [hasTelegramConnection, setHasTelegramConnection] = useState(false);
    const [telegramEnabled, setTelegramEnabled] = useState(false);
    const [isTestingWebhook, setIsTestingWebhook] = useState(false);
    const [loading, setLoading] = useState(true);

    const handlePresetSelect = (preset: MonitorPreset) => {
        setSelectedPreset(preset.key);
        setName(preset.name);
        setQuery(preset.query);
        setAntiKeywordResetKey((current) => current + 1);
        setSelectedBrands([...preset.brandIds]);
        setSelectedCategories([...preset.catalogIds]);
        setSelectedCategoryLabels([]);
        setSelectedSizes([...preset.sizeIds]);
        setSelectedColors([...preset.colorIds]);
        setSelectedStatuses([...preset.statusIds]);
        setSelectedPlatforms([]);
        setSelectedAllowedCountries([selectedRegion]);
        setPriceMin(String(preset.priceMin));
        setPriceMax(String(preset.priceMax));
    };

    const handleClearPreset = () => {
        setSelectedPreset(null);
        setName("");
        setQuery("");
        setSelectedBrands([]);
        setSelectedCategories([]);
        setSelectedCategoryLabels([]);
        setSelectedSizes([]);
        setSelectedColors([]);
        setSelectedStatuses([]);
        setSelectedPlatforms([]);
        setSelectedAllowedCountries([]);
        setPriceMin("");
        setPriceMax("");
        setAntiKeywordResetKey((current) => current + 1);
    };

    const handleRegionChange = (nextRegion: string) => {
        setSelectedAllowedCountries((current) =>
            selectedPreset &&
            current.length === 1 &&
            current[0] === selectedRegion
                ? [nextRegion]
                : current,
        );
        setSelectedRegion(nextRegion);
    };

    const handleTestWebhook = async () => {
        if (!webhookUrl) {
            toast.error("Please enter a webhook URL first");
            return;
        }
        setIsTestingWebhook(true);
        const result = await testDiscordWebhook(webhookUrl);
        setIsTestingWebhook(false);

        if (result.error) {
            toast.error(result.error);
        } else {
            toast.success("Test webhook sent successfully!");
        }
    };

    const handleQueryDelayInput = (event: FormEvent<HTMLInputElement>) => {
        const input = event.currentTarget;
        if (
            Number.isFinite(input.valueAsNumber) &&
            input.valueAsNumber > MAX_QUERY_DELAY_MS
        ) {
            input.value = String(MAX_QUERY_DELAY_MS);
        }
    };

    const handleQueryDelayBlur = (event: FocusEvent<HTMLInputElement>) => {
        const input = event.currentTarget;
        if (!input.value || !Number.isFinite(input.valueAsNumber)) {
            input.value = String(DEFAULT_QUERY_DELAY_MS);
            return;
        }
        if (input.valueAsNumber < MIN_QUERY_DELAY_MS) {
            input.value = String(MIN_QUERY_DELAY_MS);
        }
    };

    const handleCopyPreviewUrl = async () => {
        try {
            await navigator.clipboard.writeText(previewUrl);
            toast.success("Preview URL copied");
        } catch {
            toast.error("Failed to copy preview URL");
        }
    };

    const handleCreate = async (formData: FormData) => {
        const createPromise = createMonitor(formData).then((result) => {
            if (!result.ok) throw new Error(result.message);
            return result;
        });

        try {
            await toast.promise(createPromise, {
                loading: "Creating monitor...",
                success: (result) =>
                    result.started
                        ? "Monitor created"
                        : "Monitor saved paused because your active monitor limit is reached",
                error: (error) =>
                    error instanceof Error
                        ? error.message
                        : "Failed to create monitor",
            });

            const result = await createPromise;
            router.push(result.redirectTo);
            router.refresh();
        } catch {
            // Expected validation errors are shown by the toast.
        }
    };

    const handleCategoryChange = useCallback((ids: string[]) => {
        setSelectedCategories(ids);
        if (!hasVideoGamePlatformCatalog(ids)) {
            setSelectedPlatforms([]);
        }
    }, []);

    const handleCategorySelectionMetaChange = useCallback(
        ({ selectedLabels }: { selectedLabels: string[] }) => {
            setSelectedCategoryLabels((current) => {
                if (
                    current.length === selectedLabels.length &&
                    current.every(
                        (value, index) => value === selectedLabels[index],
                    )
                ) {
                    return current;
                }

                return selectedLabels;
            });
        },
        [],
    );

    useEffect(() => {
        Promise.all([
            fetch("/api/proxy-groups").then((res) => res.json()),
            fetch("/api/telegram/connection").then((res) => res.json()),
        ])
            .then(([proxyData, telegramData]) => {
                const groups = proxyData.groups || [];
                const role = proxyData.role || "free";
                const freeProxyOption = proxyData.freeProxy || {
                    enabled: false,
                    activeCount: 0,
                    minActivePerRegion: 25,
                    regions: {},
                };

                setProxyGroups(groups);
                setUserRole(role);
                setFreeProxy(freeProxyOption);
                setSelectedProxyGroup((current) => {
                    if (current) return current;
                    if (freeProxyOption.enabled) {
                        return "free";
                    }
                    if (role === "premium" || role === "admin") return "server";
                    return groups[0]?.id ? String(groups[0].id) : "";
                });
                setHasTelegramConnection(Boolean(telegramData.connected));
                setTelegramEnabled(Boolean(telegramData.connected));
                setLoading(false);
            })
            .catch(() => setLoading(false));
    }, []);

    const hasVideoGamePlatformContext =
        hasVideoGamePlatformCatalog(selectedCategories);
    const activeVideoGamePlatformIds = hasVideoGamePlatformContext
        ? selectedPlatforms
        : [];
    const previewUrl = buildVintedMonitorUrl({
        region: selectedRegion,
        query,
        priceMin,
        priceMax,
        sizeIds: selectedSizes,
        catalogIds: selectedCategories,
        brandIds: selectedBrands,
        colorIds: selectedColors,
        statusIds: selectedStatuses,
        videoGamePlatformIds: activeVideoGamePlatformIds,
    });
    const queryAlternativeCount = parseMonitorQueries(query).length;
    const selectedRegionFreeProxyHealth = getFreeProxyRegionHealth(
        freeProxy,
        selectedRegion,
    );
    const selectedRegionFreeProxyCount =
        selectedRegionFreeProxyHealth?.usable ?? 0;
    const isFreeProxyAvailableForRegion = freeProxy.enabled;
    const isFreeProxyReadyForRegion = Boolean(
        freeProxy.enabled && selectedRegionFreeProxyHealth?.healthy,
    );
    const activeFilterCount = [
        selectedAllowedCountries.length > 0,
        selectedCategories.length > 0,
        Boolean(priceMin || priceMax),
        selectedBrands.length > 0,
        selectedColors.length > 0,
        selectedStatuses.length > 0,
        activeVideoGamePlatformIds.length > 0,
        selectedSizes.length > 0,
    ].filter(Boolean).length;
    const notificationChannelCount =
        Number(Boolean(webhookUrl)) + Number(telegramEnabled);
    const selectedProxySummary = loading
        ? "Loading"
        : selectedProxyGroup === "free"
          ? "Free pool"
          : selectedProxyGroup === "server"
            ? "Server"
            : (proxyGroups.find(
                  (group) => String(group.id) === selectedProxyGroup,
              )?.name ?? "Select source");

    return (
        <div className="mx-auto max-w-4xl space-y-6">
            <div className="flex items-center gap-3">
                <Link href="/dashboard">
                    <Button variant="outline" size="icon" className="h-8 w-8">
                        <ArrowLeft className="h-4 w-4" />
                    </Button>
                </Link>
                <div>
                    <h1 className="text-2xl font-bold tracking-tight">
                        Create Monitor
                    </h1>
                    <p className="text-muted-foreground mt-0.5 text-sm">
                        Set up a new Vinted scraper.
                    </p>
                </div>
            </div>

            <Card className="border-input/60">
                <CardContent className="p-6">
                    <form action={handleCreate} className="space-y-6">
                        <input
                            type="hidden"
                            name="preset_key"
                            value={selectedPreset ?? ""}
                        />
                        <details
                            className="group border-border/60 bg-muted/20 rounded-lg border"
                            open={presetsOpen}
                            onToggle={(event) =>
                                setPresetsOpen(event.currentTarget.open)
                            }
                        >
                            <summary className="hover:bg-muted/40 flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-3 py-3 transition-colors sm:px-4 [&::-webkit-details-marker]:hidden">
                                <div className="flex min-w-0 items-center gap-2.5">
                                    <span className="bg-background border-border/70 flex size-7 shrink-0 items-center justify-center rounded-md border">
                                        <Sparkles className="size-3.5 text-amber-600 dark:text-amber-400" />
                                    </span>
                                    <div className="min-w-0">
                                        <p className="text-xs font-semibold">
                                            Quick presets
                                        </p>
                                        <p className="text-muted-foreground truncate text-[11px]">
                                            Fill the filters instantly, then
                                            tweak anything below.
                                        </p>
                                    </div>
                                </div>
                                <span className="flex shrink-0 items-center gap-2">
                                    {selectedPreset && (
                                        <span className="border-border/70 bg-background text-muted-foreground hidden rounded-md border px-2 py-1 text-[11px] font-medium sm:inline-flex">
                                            {
                                                getMonitorPreset(selectedPreset)
                                                    ?.name
                                            }
                                        </span>
                                    )}
                                    <ChevronDown className="text-muted-foreground size-4 transition-transform group-open:rotate-180" />
                                </span>
                            </summary>
                            <div className="border-border/60 border-t p-3 sm:p-4">
                                {selectedPreset && (
                                    <div className="mb-2 flex justify-end">
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            className="h-7 gap-1 px-2 text-xs"
                                            onClick={handleClearPreset}
                                        >
                                            <X className="size-3" /> Clear
                                        </Button>
                                    </div>
                                )}
                                <MonitorPresetPicker
                                    selected={selectedPreset}
                                    onSelect={handlePresetSelect}
                                    compact
                                />
                            </div>
                        </details>
                        <FormSection
                            title="Basics"
                            description="Name, keywords, polling delay, and target Vinted region."
                            icon={Settings2}
                            summary={selectedRegion.toUpperCase()}
                        >
                            <div className="space-y-2">
                                <Label htmlFor="name" className="text-[13px]">
                                    Monitor Name
                                </Label>
                                <Input
                                    name="name"
                                    id="name"
                                    placeholder="e.g. Nike Jackets DE"
                                    value={name}
                                    onChange={(event) =>
                                        setName(event.target.value)
                                    }
                                    required
                                />
                                <p className="text-muted-foreground text-[12px]">
                                    Internal name for this monitor in the
                                    dashboard and notifications.
                                </p>
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="query" className="text-[13px]">
                                    Search Queries{" "}
                                    <span className="text-muted-foreground font-normal">
                                        (optional)
                                    </span>
                                </Label>
                                <Input
                                    name="query"
                                    id="query"
                                    placeholder="e.g. ps1, playstation 1, ps one"
                                    value={query}
                                    maxLength={MAX_MONITOR_QUERY_LENGTH}
                                    onChange={(event) =>
                                        setQuery(event.target.value)
                                    }
                                />
                                <p className="text-muted-foreground text-[12px]">
                                    Separate alternative searches with commas.
                                    Vintrack rotates them without increasing the
                                    polling rate
                                    {queryAlternativeCount > 1
                                        ? ` (${queryAlternativeCount} searches)`
                                        : ""}
                                    .
                                </p>
                            </div>

                            <div className="space-y-2">
                                <Label
                                    htmlFor="anti_keywords"
                                    className="text-[13px]"
                                >
                                    Anti Keywords{" "}
                                    <span className="text-muted-foreground font-normal">
                                        (optional)
                                    </span>
                                </Label>
                                <AntiKeywordInput
                                    key={antiKeywordResetKey}
                                    name="anti_keywords"
                                    defaultValue={
                                        selectedPreset
                                            ? getMonitorPreset(
                                                  selectedPreset,
                                              )?.antiKeywords.join(",")
                                            : undefined
                                    }
                                />
                                <p className="text-muted-foreground text-[12px]">
                                    New items matching any anti keyword in title
                                    or description will be skipped. Duplicate
                                    entries are removed automatically.
                                </p>
                            </div>

                            <div className="space-y-2">
                                <Label
                                    htmlFor="query_delay_ms"
                                    className="text-[13px]"
                                >
                                    Query Delay
                                </Label>
                                <Input
                                    type="number"
                                    name="query_delay_ms"
                                    id="query_delay_ms"
                                    min={MIN_QUERY_DELAY_MS}
                                    max={MAX_QUERY_DELAY_MS}
                                    step={100}
                                    defaultValue={DEFAULT_QUERY_DELAY_MS}
                                    onInput={handleQueryDelayInput}
                                    onBlur={handleQueryDelayBlur}
                                    required
                                />
                                <p className="text-muted-foreground text-[12px]">
                                    Time between Vinted catalog checks in
                                    milliseconds. Between Min.{" "}
                                    {MIN_QUERY_DELAY_MS} ms. - Max.{" "}
                                    {MAX_QUERY_DELAY_MS} ms.
                                </p>
                            </div>

                            <div className="space-y-2">
                                <Label className="text-[13px]">
                                    Country / Region
                                </Label>
                                <RegionPicker
                                    selected={selectedRegion}
                                    onChange={handleRegionChange}
                                />
                                <input
                                    type="hidden"
                                    name="region"
                                    value={selectedRegion}
                                />
                                <p className="text-muted-foreground text-[12px]">
                                    Select which Vinted country to monitor.
                                    Default is Germany (vinted.de).
                                </p>
                            </div>
                        </FormSection>

                        <FormSection
                            title="Filters"
                            description="Optional item filters for narrowing the catalog results."
                            defaultOpen={false}
                            icon={SlidersHorizontal}
                            summary={
                                activeFilterCount > 0
                                    ? `${activeFilterCount} active`
                                    : "Optional"
                            }
                        >
                            <div className="space-y-2">
                                <Label className="text-[13px]">
                                    Strict Item Location Filter{" "}
                                    <span className="text-muted-foreground font-normal">
                                        (optional)
                                    </span>
                                </Label>
                                <CountryFilterPicker
                                    selected={selectedAllowedCountries}
                                    onChange={setSelectedAllowedCountries}
                                />
                                <input
                                    type="hidden"
                                    name="allowed_countries"
                                    value={selectedAllowedCountries.join(",")}
                                />
                                <p className="text-muted-foreground text-[12px]">
                                    Only items located in these countries will
                                    be sent/saved. Leave empty to allow all
                                    countries.
                                </p>
                            </div>

                            <div className="space-y-2">
                                <Label className="text-[13px]">
                                    Category Filter{" "}
                                    <span className="text-muted-foreground font-normal">
                                        (optional)
                                    </span>
                                </Label>
                                <CategoryPicker
                                    region={selectedRegion}
                                    selected={selectedCategories}
                                    onChange={handleCategoryChange}
                                    onSelectionMetaChange={
                                        handleCategorySelectionMetaChange
                                    }
                                />
                                <input
                                    type="hidden"
                                    name="catalog_ids"
                                    value={selectedCategories.join(",")}
                                />
                                <p className="text-muted-foreground text-[12px]">
                                    Limit results to specific Vinted categories.
                                    Select only Video games & consoles to unlock
                                    the Platform filter.
                                </p>
                            </div>

                            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                <div className="space-y-2">
                                    <Label
                                        htmlFor="price_min"
                                        className="text-[13px]"
                                    >
                                        Min Price
                                    </Label>
                                    <div className="relative">
                                        <span className="text-muted-foreground absolute top-1/2 left-3 -translate-y-1/2 text-sm">
                                            €
                                        </span>
                                        <Input
                                            type="number"
                                            name="price_min"
                                            placeholder="0"
                                            className="pl-7"
                                            value={priceMin}
                                            onChange={(event) =>
                                                setPriceMin(event.target.value)
                                            }
                                        />
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <Label
                                        htmlFor="price_max"
                                        className="text-[13px]"
                                    >
                                        Max Price
                                    </Label>
                                    <div className="relative">
                                        <span className="text-muted-foreground absolute top-1/2 left-3 -translate-y-1/2 text-sm">
                                            €
                                        </span>
                                        <Input
                                            type="number"
                                            name="price_max"
                                            placeholder="Any"
                                            className="pl-7"
                                            value={priceMax}
                                            onChange={(event) =>
                                                setPriceMax(event.target.value)
                                            }
                                        />
                                    </div>
                                </div>
                            </div>

                            <div className="space-y-2">
                                <Label className="text-[13px]">
                                    Brand Filter{" "}
                                    <span className="text-muted-foreground font-normal">
                                        (optional)
                                    </span>
                                </Label>
                                <BrandPicker
                                    selected={selectedBrands}
                                    onChange={setSelectedBrands}
                                    region={selectedRegion}
                                    catalogIds={selectedCategories}
                                />
                                <input
                                    type="hidden"
                                    name="brand_ids"
                                    value={selectedBrands.join(",")}
                                />
                                <p className="text-muted-foreground text-[12px]">
                                    Limit results to specific brands.
                                </p>
                            </div>

                            <div className="space-y-2">
                                <Label className="text-[13px]">
                                    Color Filter{" "}
                                    <span className="text-muted-foreground font-normal">
                                        (optional)
                                    </span>
                                </Label>
                                <ColorPicker
                                    selected={selectedColors}
                                    onChange={setSelectedColors}
                                />
                                <input
                                    type="hidden"
                                    name="color_ids"
                                    value={selectedColors.join(",")}
                                />
                                <p className="text-muted-foreground text-[12px]">
                                    Limit results to specific colors.
                                </p>
                            </div>

                            {hasVideoGamePlatformContext && (
                                <div className="space-y-2">
                                    <Label className="text-[13px]">
                                        Platform Filter{" "}
                                        <span className="text-muted-foreground font-normal">
                                            (optional)
                                        </span>
                                    </Label>
                                    <PlatformPicker
                                        selected={selectedPlatforms}
                                        onChange={setSelectedPlatforms}
                                        region={selectedRegion}
                                        catalogIds={selectedCategories}
                                    />
                                    <input
                                        type="hidden"
                                        name="video_game_platform_ids"
                                        value={selectedPlatforms.join(",")}
                                    />
                                    <p className="text-muted-foreground text-[12px]">
                                        Available for Video games & consoles.
                                        This is separate from Brand.
                                    </p>
                                </div>
                            )}

                            <div className="space-y-2">
                                <Label className="text-[13px]">
                                    Condition Filter{" "}
                                    <span className="text-muted-foreground font-normal">
                                        (optional)
                                    </span>
                                </Label>
                                <StatusPicker
                                    selected={selectedStatuses}
                                    onChange={setSelectedStatuses}
                                    locale={getStatusLocaleForRegionCodes(
                                        selectedAllowedCountries.join(","),
                                        selectedRegion,
                                    )}
                                />
                                <input
                                    type="hidden"
                                    name="status_ids"
                                    value={selectedStatuses.join(",")}
                                />
                                <p className="text-muted-foreground text-[12px]">
                                    Pick one or more item conditions. Leave
                                    empty to allow all conditions.
                                </p>
                            </div>

                            <div className="space-y-2.5">
                                <Label className="text-[13px]">
                                    Size Filter{" "}
                                    <span className="text-muted-foreground font-normal">
                                        (optional)
                                    </span>
                                </Label>
                                <SizePicker
                                    key={`sizes-${selectedPreset ?? "custom"}`}
                                    selected={selectedSizes}
                                    onChange={setSelectedSizes}
                                    defaultGroup={
                                        getMonitorPreset(selectedPreset)
                                            ?.sizeGroupKey
                                    }
                                />
                                <input
                                    type="hidden"
                                    name="size_id"
                                    value={selectedSizes.join(",")}
                                />
                            </div>
                        </FormSection>

                        <QuietHoursSection />

                        <FormSection
                            title="Notifications"
                            description="Choose where new item alerts should be sent."
                            defaultOpen={false}
                            icon={Bell}
                            summary={
                                notificationChannelCount > 0
                                    ? `${notificationChannelCount} active`
                                    : "Not configured"
                            }
                        >
                            <div className="space-y-2">
                                <Label
                                    htmlFor="discord_webhook"
                                    className="text-[13px]"
                                >
                                    Discord Webhook{" "}
                                    <span className="text-muted-foreground font-normal">
                                        (optional)
                                    </span>
                                </Label>
                                <div className="flex gap-2">
                                    <Input
                                        name="discord_webhook"
                                        id="discord_webhook"
                                        placeholder="https://discord.com/api/webhooks/..."
                                        value={webhookUrl}
                                        onChange={(e) =>
                                            setWebhookUrl(e.target.value)
                                        }
                                        className="flex-1"
                                    />
                                    <Button
                                        type="button"
                                        variant="outline"
                                        onClick={handleTestWebhook}
                                        disabled={
                                            isTestingWebhook || !webhookUrl
                                        }
                                        className="shrink-0 gap-2"
                                    >
                                        <Send className="h-4 w-4" />
                                        {isTestingWebhook
                                            ? "Testing..."
                                            : "Test"}
                                    </Button>
                                </div>
                            </div>

                            <div className="space-y-2">
                                <input
                                    type="hidden"
                                    name="telegram_active"
                                    value={telegramEnabled ? "true" : "false"}
                                />
                                <div className="border-border/80 bg-muted/30 flex items-center justify-between rounded-lg border p-3">
                                    <div className="space-y-0.5">
                                        <Label className="text-[13px]">
                                            Telegram Notifications
                                        </Label>
                                        <p className="text-muted-foreground text-[12px]">
                                            {hasTelegramConnection
                                                ? "Send alerts for this monitor to your connected Telegram chat."
                                                : "Connect Telegram from the dashboard notification settings first."}
                                        </p>
                                    </div>
                                    <Switch
                                        checked={telegramEnabled}
                                        disabled={!hasTelegramConnection}
                                        onCheckedChange={setTelegramEnabled}
                                    />
                                </div>
                            </div>
                        </FormSection>

                        <FormSection
                            title="Proxy Source"
                            description="Select the connection pool used for Vinted checks."
                            icon={Network}
                            summary={selectedProxySummary}
                        >
                            <div className="space-y-2">
                                <Label className="text-[13px]">
                                    Proxy Source
                                </Label>
                                {loading ? (
                                    <div className="bg-muted h-10 animate-pulse rounded-md" />
                                ) : (
                                    <>
                                        <RegionPoolStatus
                                            freeProxy={freeProxy}
                                            selectedRegion={selectedRegion}
                                            onSelectRegion={setSelectedRegion}
                                        />
                                        <select
                                            name="proxy_group_id"
                                            value={selectedProxyGroup}
                                            onChange={(e) =>
                                                setSelectedProxyGroup(
                                                    e.target.value,
                                                )
                                            }
                                            className="border-input bg-background text-foreground h-10 w-full rounded-md border px-3 text-[13px] focus:ring-2 focus:ring-slate-900 focus:ring-offset-1 focus:outline-none"
                                            required={userRole === "free"}
                                        >
                                            {userRole === "free" && (
                                                <option value="" disabled>
                                                    Select a proxy source
                                                </option>
                                            )}
                                            {(isFreeProxyAvailableForRegion ||
                                                selectedProxyGroup ===
                                                    "free") && (
                                                <option
                                                    value="free"
                                                    disabled={
                                                        !isFreeProxyAvailableForRegion
                                                    }
                                                >
                                                    Free Proxy Pool (
                                                    {
                                                        selectedRegionFreeProxyCount
                                                    }{" "}
                                                    usable
                                                    {isFreeProxyAvailableForRegion
                                                        ? isFreeProxyReadyForRegion
                                                            ? ""
                                                            : ", recovering"
                                                        : ", disabled"}
                                                    )
                                                </option>
                                            )}
                                            {(userRole === "premium" ||
                                                userRole === "admin") && (
                                                <option value="server">
                                                    Server Proxies (Premium)
                                                </option>
                                            )}
                                            {proxyGroups.length === 0 &&
                                                userRole === "free" &&
                                                !isFreeProxyAvailableForRegion && (
                                                    <option value="" disabled>
                                                        No proxy groups — create
                                                        one first
                                                    </option>
                                                )}
                                            {proxyGroups.map((g) => (
                                                <option
                                                    key={g.id}
                                                    value={g.id.toString()}
                                                >
                                                    {g.name} ({g.proxyCount}{" "}
                                                    proxies)
                                                </option>
                                            ))}
                                        </select>
                                        {userRole === "free" &&
                                            proxyGroups.length === 0 &&
                                            !isFreeProxyAvailableForRegion && (
                                                <p className="text-[12px] text-amber-600">
                                                    You need to{" "}
                                                    <Link
                                                        href="/proxies"
                                                        className="font-medium underline"
                                                    >
                                                        create a proxy group
                                                    </Link>{" "}
                                                    before creating a monitor.
                                                </p>
                                            )}
                                        {userRole === "free" && (
                                            <p className="text-muted-foreground text-[12px]">
                                                Select your proxy group or the
                                                admin managed free pool. Free
                                                pool monitors wait and resume
                                                automatically while a region is
                                                recovering.
                                            </p>
                                        )}
                                        {(userRole === "premium" ||
                                            userRole === "admin") && (
                                            <p className="text-muted-foreground text-[12px]">
                                                Use server proxies or select
                                                your own group.
                                            </p>
                                        )}
                                    </>
                                )}
                            </div>
                        </FormSection>

                        <FormSection
                            title="Preview"
                            description="Generated Vinted catalog URL for the current setup."
                            defaultOpen={false}
                            icon={Eye}
                            summary="Vinted URL"
                        >
                            <div className="space-y-2">
                                <Label className="text-[13px]">
                                    Monitor URL Preview
                                </Label>
                                <div className="border-border/70 bg-muted/20 rounded-xl border p-3">
                                    <div className="flex items-center justify-between gap-3">
                                        <p className="text-muted-foreground text-[12px]">
                                            {queryAlternativeCount > 1
                                                ? `Showing the first of ${queryAlternativeCount} rotating search URLs.`
                                                : "This is the exact Vinted catalog URL for the current filter setup."}
                                        </p>
                                        <a
                                            href={previewUrl}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="border-input bg-background text-foreground hover:bg-muted inline-flex shrink-0 items-center gap-1 rounded-md border px-2.5 py-1.5 text-[12px] font-medium transition-colors"
                                        >
                                            Test URL
                                            <ExternalLink className="h-3.5 w-3.5" />
                                        </a>
                                    </div>
                                    <div className="relative mt-3">
                                        <div className="border-border/70 bg-background overflow-x-auto rounded-lg border px-3 py-3 pr-12">
                                            <code className="text-foreground/90 block text-[11px] break-all whitespace-pre-wrap">
                                                {previewUrl}
                                            </code>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={handleCopyPreviewUrl}
                                            className="border-border/70 bg-background text-muted-foreground hover:bg-muted hover:text-foreground absolute top-1/2 right-2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md border transition-colors"
                                            aria-label="Copy preview URL"
                                            title="Copy URL"
                                        >
                                            <Copy className="h-3.5 w-3.5" />
                                        </button>
                                    </div>
                                    {selectedCategoryLabels.length > 0 && (
                                        <div className="mt-3 flex flex-wrap gap-1.5">
                                            {selectedCategoryLabels.map(
                                                (label) => (
                                                    <span
                                                        key={label}
                                                        className="border-border/70 bg-background text-muted-foreground inline-flex items-center rounded-full border px-2 py-1 text-[11px]"
                                                    >
                                                        {label}
                                                    </span>
                                                ),
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </FormSection>

                        <div className="pt-2">
                            <Button
                                type="submit"
                                className="w-full gap-1.5"
                                disabled={
                                    (userRole === "free" &&
                                        !selectedProxyGroup) ||
                                    (selectedProxyGroup === "free" &&
                                        !isFreeProxyAvailableForRegion)
                                }
                            >
                                <Plus className="h-4 w-4" /> Create Monitor
                            </Button>
                        </div>
                    </form>
                </CardContent>
            </Card>
        </div>
    );
}
