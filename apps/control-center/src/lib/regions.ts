export type Region = {
    code: string;
    label: string;
    flag: string;
    domain: string;
};

const STATUS_LOCALE_BY_REGION: Record<string, string> = {
    de: "de",
    at: "de",
    fr: "fr",
    be: "fr",
    lu: "fr",
    it: "it",
    es: "es",
    nl: "nl",
    pl: "pl",
    pt: "pt",
    uk: "en",
    ie: "en",
    cz: "cs",
    sk: "sk",
    lt: "lt",
    se: "sv",
    dk: "da",
    ro: "ro",
    hu: "hu",
    hr: "hr",
    fi: "fi",
    si: "sl",
    gr: "el",
};

export const REGIONS: Region[] = [
    { code: "de", label: "Germany", flag: "🇩🇪", domain: "vinted.de" },
    { code: "fr", label: "France", flag: "🇫🇷", domain: "vinted.fr" },
    { code: "it", label: "Italy", flag: "🇮🇹", domain: "vinted.it" },
    { code: "es", label: "Spain", flag: "🇪🇸", domain: "vinted.es" },
    { code: "nl", label: "Netherlands", flag: "🇳🇱", domain: "vinted.nl" },
    { code: "pl", label: "Poland", flag: "🇵🇱", domain: "vinted.pl" },
    { code: "pt", label: "Portugal", flag: "🇵🇹", domain: "vinted.pt" },
    { code: "be", label: "Belgium", flag: "🇧🇪", domain: "vinted.be" },
    { code: "at", label: "Austria", flag: "🇦🇹", domain: "vinted.at" },
    { code: "lu", label: "Luxembourg", flag: "🇱🇺", domain: "vinted.lu" },
    { code: "uk", label: "United Kingdom", flag: "🇬🇧", domain: "vinted.co.uk" },
    { code: "ie", label: "Ireland", flag: "🇮🇪", domain: "vinted.ie" },
    { code: "cz", label: "Czech Republic", flag: "🇨🇿", domain: "vinted.cz" },
    { code: "sk", label: "Slovakia", flag: "🇸🇰", domain: "vinted.sk" },
    { code: "lt", label: "Lithuania", flag: "🇱🇹", domain: "vinted.lt" },
    { code: "se", label: "Sweden", flag: "🇸🇪", domain: "vinted.se" },
    { code: "dk", label: "Denmark", flag: "🇩🇰", domain: "vinted.dk" },
    { code: "ro", label: "Romania", flag: "🇷🇴", domain: "vinted.ro" },
    { code: "hu", label: "Hungary", flag: "🇭🇺", domain: "vinted.hu" },
    { code: "hr", label: "Croatia", flag: "🇭🇷", domain: "vinted.hr" },
    { code: "fi", label: "Finland", flag: "🇫🇮", domain: "vinted.fi" },
];

const REGIONS_BY_CODE: Record<string, Region> = Object.create(null);
for (const region of REGIONS) {
    REGIONS_BY_CODE[region.code] = region;
}

export function getRegionLabel(code: string): string {
    const region = REGIONS_BY_CODE[code];
    if (!region) return code.toUpperCase();
    return `${region.flag} ${region.label}`;
}

export function getRegionDomain(code: string): string {
    return REGIONS_BY_CODE[code]?.domain ?? "vinted.de";
}

export function getRegionFlag(code: string): string {
    return REGIONS_BY_CODE[code]?.flag ?? "🌐";
}

export function getRegionFlags(codesString: string): string[] {
    if (!codesString) return [];
    const codes = codesString.split(",").filter(Boolean);
    return codes.map(
        (code) => REGIONS_BY_CODE[code]?.flag || code.toUpperCase(),
    );
}

export function getStatusLocaleForRegion(
    code: string | null | undefined,
): string {
    if (!code) return "en";
    return STATUS_LOCALE_BY_REGION[code] ?? "en";
}

export function getStatusLocaleForRegionCodes(
    codesString: string | null | undefined,
    fallbackCode?: string | null,
): string {
    if (codesString) {
        const firstCode = codesString
            .split(",")
            .map((code) => code.trim())
            .find(Boolean);
        if (firstCode) {
            return getStatusLocaleForRegion(firstCode);
        }
    }

    return getStatusLocaleForRegion(fallbackCode);
}
