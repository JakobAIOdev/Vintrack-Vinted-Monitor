export type Region = {
  code: string;
  label: string;
  flag: string;
  domain: string;
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

export function getRegionLabel(code: string): string {
  const region = REGIONS.find((r) => r.code === code);
  if (!region) return code.toUpperCase();
  return `${region.flag} ${region.label}`;
}

export function getRegionFlag(code: string): string {
  const region = REGIONS.find((r) => r.code === code);
  return region?.flag ?? "🌐";
}
