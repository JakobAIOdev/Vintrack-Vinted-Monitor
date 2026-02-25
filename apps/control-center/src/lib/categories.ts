export type Category = {
  id: number;
  label: string;
  slug: string;
  children: Category[];
};

export const CATEGORIES: Category[] = [
  {
    id: 1904,
    label: "Women",
    slug: "women_root",
    children: [
      { id: 4, label: "Clothing", slug: "womens", children: [] },
      { id: 16, label: "Shoes", slug: "footwear", children: [] },
      { id: 19, label: "Bags", slug: "bags_backpacks", children: [] },
      { id: 1187, label: "Accessories", slug: "accessories_jewellery", children: [] },
      { id: 146, label: "Beauty", slug: "cosmetics_and_beauty_products", children: [] },
    ],
  },
  {
    id: 5,
    label: "Men",
    slug: "mens",
    children: [
      { id: 2050, label: "Clothing", slug: "men_clothing", children: [] },
      { id: 1231, label: "Shoes", slug: "men_shoes_new", children: [] },
      { id: 82, label: "Accessories", slug: "men_accessories", children: [] },
      { id: 139, label: "Body & Face Care", slug: "cosmetics_and_beauty_items", children: [] },
    ],
  },
  {
    id: 1193,
    label: "Kids",
    slug: "children_new",
    children: [
      { id: 1195, label: "Girls", slug: "girls_new", children: [] },
      { id: 1194, label: "Boys", slug: "boys_new", children: [] },
      { id: 1499, label: "Toys", slug: "toys_and_games_new", children: [] },
      { id: 1500, label: "Baby Care", slug: "baby_care_new", children: [] },
      { id: 1496, label: "Strollers & Buggies", slug: "strollers_new", children: [] },
      { id: 1497, label: "Kids' Vehicles", slug: "moving_gear_new", children: [] },
      { id: 1495, label: "High Chairs & Car Seats", slug: "chairs_new", children: [] },
      { id: 1498, label: "Kids' Furniture", slug: "kids_furniture_new", children: [] },
      { id: 1501, label: "School Supplies", slug: "books_and_school_new", children: [] },
      { id: 1502, label: "Other", slug: "all_other_new", children: [] },
    ],
  },
  {
    id: 1918,
    label: "Home",
    slug: "home",
    children: [
      { id: 1919, label: "Textiles", slug: "h_textiles", children: [] },
      { id: 1934, label: "Decor", slug: "h_accessories", children: [] },
      { id: 1920, label: "Tableware", slug: "h_tableware", children: [] },
      { id: 2915, label: "Holidays & Celebrations", slug: "holidays_celebrations", children: [] },
    ],
  },
  {
    id: 2309,
    label: "Entertainment",
    slug: "entertainment",
    children: [
      { id: 2313, label: "Video Games & Consoles", slug: "video_games_consoles", children: [] },
      { id: 2311, label: "Games & Puzzles", slug: "games_and_puzzles", children: [] },
      { id: 2310, label: "Music & Video", slug: "cd_dvd_audio_new", children: [] },
      { id: 2312, label: "Books", slug: "books", children: [] },
    ],
  },
  {
    id: 2093,
    label: "Pet Supplies",
    slug: "pet_care",
    children: [
      { id: 2095, label: "Dogs", slug: "dogs", children: [] },
      { id: 2096, label: "Cats", slug: "cats", children: [] },
      { id: 2138, label: "Small Pets", slug: "small_pets", children: [] },
      { id: 2485, label: "Fish", slug: "fish", children: [] },
      { id: 2486, label: "Birds", slug: "birds", children: [] },
      { id: 2487, label: "Reptiles", slug: "reptiles", children: [] },
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
