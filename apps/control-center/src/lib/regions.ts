export type Region = {
    code: string;
    label: string;
    flag: string;
    domain: string;
    currencyCode: string;
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
    { code: "de", label: "Germany", flag: "🇩🇪", domain: "vinted.de", currencyCode: "EUR" },
    { code: "fr", label: "France", flag: "🇫🇷", domain: "vinted.fr", currencyCode: "EUR" },
    { code: "it", label: "Italy", flag: "🇮🇹", domain: "vinted.it", currencyCode: "EUR" },
    { code: "es", label: "Spain", flag: "🇪🇸", domain: "vinted.es", currencyCode: "EUR" },
    { code: "nl", label: "Netherlands", flag: "🇳🇱", domain: "vinted.nl", currencyCode: "EUR" },
    { code: "pl", label: "Poland", flag: "🇵🇱", domain: "vinted.pl", currencyCode: "PLN" },
    { code: "pt", label: "Portugal", flag: "🇵🇹", domain: "vinted.pt", currencyCode: "EUR" },
    { code: "be", label: "Belgium", flag: "🇧🇪", domain: "vinted.be", currencyCode: "EUR" },
    { code: "at", label: "Austria", flag: "🇦🇹", domain: "vinted.at", currencyCode: "EUR" },
    { code: "lu", label: "Luxembourg", flag: "🇱🇺", domain: "vinted.lu", currencyCode: "EUR" },
    { code: "uk", label: "United Kingdom", flag: "🇬🇧", domain: "vinted.co.uk", currencyCode: "GBP" },
    { code: "ie", label: "Ireland", flag: "🇮🇪", domain: "vinted.ie", currencyCode: "EUR" },
    { code: "cz", label: "Czech Republic", flag: "🇨🇿", domain: "vinted.cz", currencyCode: "CZK" },
    { code: "sk", label: "Slovakia", flag: "🇸🇰", domain: "vinted.sk", currencyCode: "EUR" },
    { code: "lt", label: "Lithuania", flag: "🇱🇹", domain: "vinted.lt", currencyCode: "EUR" },
    { code: "se", label: "Sweden", flag: "🇸🇪", domain: "vinted.se", currencyCode: "SEK" },
    { code: "dk", label: "Denmark", flag: "🇩🇰", domain: "vinted.dk", currencyCode: "DKK" },
    { code: "ro", label: "Romania", flag: "🇷🇴", domain: "vinted.ro", currencyCode: "RON" },
    { code: "hu", label: "Hungary", flag: "🇭🇺", domain: "vinted.hu", currencyCode: "HUF" },
    { code: "hr", label: "Croatia", flag: "🇭🇷", domain: "vinted.hr", currencyCode: "EUR" },
    { code: "fi", label: "Finland", flag: "🇫🇮", domain: "vinted.fi", currencyCode: "EUR" },
];

const TIMEZONE_BY_REGION: Record<string, string> = {
    de: "Europe/Berlin",
    fr: "Europe/Paris",
    it: "Europe/Rome",
    es: "Europe/Madrid",
    nl: "Europe/Amsterdam",
    pl: "Europe/Warsaw",
    pt: "Europe/Lisbon",
    be: "Europe/Brussels",
    at: "Europe/Vienna",
    lu: "Europe/Luxembourg",
    uk: "Europe/London",
    ie: "Europe/Dublin",
    cz: "Europe/Prague",
    sk: "Europe/Bratislava",
    lt: "Europe/Vilnius",
    se: "Europe/Stockholm",
    dk: "Europe/Copenhagen",
    ro: "Europe/Bucharest",
    hu: "Europe/Budapest",
    hr: "Europe/Zagreb",
    fi: "Europe/Helsinki",
};

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

export function getRegionCurrencyCode(code: string): string {
    return REGIONS_BY_CODE[code]?.currencyCode ?? "EUR";
}

export function getRegionTimezone(code: string): string {
    return TIMEZONE_BY_REGION[code] ?? "Europe/Berlin";
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
