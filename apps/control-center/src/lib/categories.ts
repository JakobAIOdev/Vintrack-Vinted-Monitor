export type Category = {
  id: number;
  label: string;
  slug: string;
  children: Category[];
};

export const CATEGORIES: Category[] = [
  {
    id: 1904,
    label: "Damen",
    slug: "women_root",
    children: [
      { id: 4, label: "Kleidung", slug: "womens", children: [] },
      { id: 16, label: "Schuhe", slug: "footwear", children: [] },
      { id: 19, label: "Taschen", slug: "bags_backpacks", children: [] },
      { id: 1187, label: "Accessoires", slug: "accessories_jewellery", children: [] },
      { id: 146, label: "Beauty", slug: "cosmetics_and_beauty_products", children: [] },
    ],
  },
  {
    id: 5,
    label: "Herren",
    slug: "mens",
    children: [
      { id: 2050, label: "Kleidung", slug: "men_clothing", children: [] },
      { id: 1231, label: "Schuhe", slug: "men_shoes_new", children: [] },
      { id: 82, label: "Accessoires", slug: "men_accessories", children: [] },
      { id: 139, label: "Körper- & Gesichtspflege", slug: "cosmetics_and_beauty_items", children: [] },
    ],
  },
  {
    id: 1193,
    label: "Kinder",
    slug: "children_new",
    children: [
      { id: 1195, label: "Mädchen", slug: "girls_new", children: [] },
      { id: 1194, label: "Jungs", slug: "boys_new", children: [] },
      { id: 1499, label: "Spielzeug", slug: "toys_and_games_new", children: [] },
      { id: 1500, label: "Ausstattung", slug: "baby_care_new", children: [] },
      { id: 1496, label: "Kinderwagen & Buggys", slug: "strollers_new", children: [] },
      { id: 1497, label: "Kinderfahrzeuge", slug: "moving_gear_new", children: [] },
      { id: 1495, label: "Hochstühle & Autositze", slug: "chairs_new", children: [] },
      { id: 1498, label: "Kindermöbel", slug: "kids_furniture_new", children: [] },
      { id: 1501, label: "Schulsachen", slug: "books_and_school_new", children: [] },
      { id: 1502, label: "Sonstige", slug: "all_other_new", children: [] },
    ],
  },
  {
    id: 1918,
    label: "Home",
    slug: "home",
    children: [
      { id: 1919, label: "Textilien", slug: "h_textiles", children: [] },
      { id: 1934, label: "Deko", slug: "h_accessories", children: [] },
      { id: 1920, label: "Essen", slug: "h_tableware", children: [] },
      { id: 2915, label: "Feste & Feiertage", slug: "holidays_celebrations", children: [] },
    ],
  },
  {
    id: 2309,
    label: "Unterhaltung",
    slug: "entertainment",
    children: [
      { id: 2313, label: "Videospiele & Konsolen", slug: "video_games_consoles", children: [] },
      { id: 2311, label: "Spiele & Rätsel", slug: "games_and_puzzles", children: [] },
      { id: 2310, label: "Musik & Video", slug: "cd_dvd_audio_new", children: [] },
      { id: 2312, label: "Bücher", slug: "books", children: [] },
    ],
  },
  {
    id: 2093,
    label: "Haustierbedarf",
    slug: "pet_care",
    children: [
      { id: 2095, label: "Hunde", slug: "dogs", children: [] },
      { id: 2096, label: "Katzen", slug: "cats", children: [] },
      { id: 2138, label: "Kleintiere", slug: "small_pets", children: [] },
      { id: 2485, label: "Fische", slug: "fish", children: [] },
      { id: 2486, label: "Vögel", slug: "birds", children: [] },
      { id: 2487, label: "Reptilien", slug: "reptiles", children: [] },
    ],
  },
];

export function getCategoryLabel(id: string): string {
  const numId = Number(id);
  for (const group of CATEGORIES) {
    if (group.id === numId) return group.label;
    for (const child of group.children) {
      if (child.id === numId) return `${group.label} › ${child.label}`;
    }
  }
  return id;
}

export function getCategoryLabels(catalogIds: string | null | undefined): string[] {
  if (!catalogIds) return [];
  return catalogIds
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(getCategoryLabel);
}
