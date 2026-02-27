export type Color = { label: string; id: string; hex: string };

export const COLORS: Color[] = [
  { label: "Black", id: "1", hex: "#000000" },
  { label: "Grey", id: "3", hex: "#919191" },
  { label: "White", id: "12", hex: "#FFFFFF" },
  { label: "Cream", id: "20", hex: "#F5F0E1" },
  { label: "Beige", id: "4", hex: "#D4C5A9" },
  { label: "Orange", id: "11", hex: "#FF8C00" },
  { label: "Yellow", id: "8", hex: "#FFD700" },
  { label: "Green", id: "7", hex: "#228B22" },
  { label: "Khaki", id: "17", hex: "#6B7A4F" },
  { label: "Mint", id: "22", hex: "#98FF98" },
  { label: "Turquoise", id: "19", hex: "#40E0D0" },
  { label: "Blue", id: "9", hex: "#1E90FF" },
  { label: "Light Blue", id: "14", hex: "#87CEEB" },
  { label: "Dark Blue", id: "23", hex: "#00008B" },
  { label: "Purple", id: "6", hex: "#8B008B" },
  { label: "Lilac", id: "21", hex: "#C8A2C8" },
  { label: "Pink", id: "5", hex: "#FF69B4" },
  { label: "Red", id: "2", hex: "#DC143C" },
  { label: "Burgundy", id: "18", hex: "#722F37" },
  { label: "Brown", id: "10", hex: "#8B4513" },
  { label: "Coral", id: "24", hex: "#FF7F50" },
  { label: "Gold", id: "15", hex: "#FFD700" },
  { label: "Silver", id: "13", hex: "#C0C0C0" },
  { label: "Multicolor", id: "16", hex: "multi" },
];

export function getColorLabels(ids: string): string[] {
  return ids
    .split(",")
    .map((id) => COLORS.find((c) => c.id === id.trim())?.label)
    .filter(Boolean) as string[];
}
