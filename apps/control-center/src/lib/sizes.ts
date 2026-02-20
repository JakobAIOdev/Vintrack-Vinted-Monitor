export type SizeOption = { label: string; id: number };

export type SizeGroup = {
  key: string;
  label: string;
  sizes: SizeOption[];
};

export const SIZE_GROUPS: SizeGroup[] = [
  {
    key: "14",
    label: "Allgemein (XS–8XL)",
    sizes: [
      { label: "XS", id: 206 },
      { label: "S", id: 207 },
      { label: "M", id: 208 },
      { label: "L", id: 209 },
      { label: "XL", id: 210 },
      { label: "XXL", id: 211 },
      { label: "XXXL", id: 212 },
      { label: "4XL", id: 308 },
      { label: "5XL", id: 309 },
      { label: "6XL", id: 1192 },
      { label: "7XL", id: 1193 },
      { label: "8XL", id: 1194 },
    ],
  },
  {
    key: "4",
    label: "Damen Kleidung (30–58)",
    sizes: [
      { label: "XXXS / 30", id: 1226 },
      { label: "XXS / 32", id: 102 },
      { label: "XS / 34", id: 2 },
      { label: "S / 36", id: 3 },
      { label: "M / 38", id: 4 },
      { label: "L / 40", id: 5 },
      { label: "XL / 42", id: 6 },
      { label: "XXL / 44", id: 7 },
      { label: "XXXL / 46", id: 310 },
      { label: "4XL / 48", id: 311 },
      { label: "5XL / 50", id: 312 },
      { label: "6XL / 52", id: 1227 },
      { label: "7XL / 54", id: 1228 },
      { label: "8XL / 56", id: 1229 },
      { label: "9XL / 58", id: 1230 },
    ],
  },
  {
    key: "7",
    label: "Damen Schuhe (34–46)",
    sizes: [
      { label: "34", id: 1364 },
      { label: "34.5", id: 1580 },
      { label: "35", id: 55 },
      { label: "35.5", id: 1195 },
      { label: "36", id: 56 },
      { label: "36.5", id: 1196 },
      { label: "37", id: 57 },
      { label: "37.5", id: 1197 },
      { label: "38", id: 58 },
      { label: "38.5", id: 1198 },
      { label: "39", id: 59 },
      { label: "39.5", id: 1199 },
      { label: "40", id: 60 },
      { label: "40.5", id: 1200 },
      { label: "41", id: 61 },
      { label: "41.5", id: 1201 },
      { label: "42", id: 62 },
      { label: "42.5", id: 1579 },
      { label: "43", id: 63 },
      { label: "44", id: 1574 },
      { label: "45", id: 1576 },
      { label: "46", id: 1578 },
    ],
  },
  {
    key: "38",
    label: "Herren Schuhe (38–48,5)",
    sizes: [
      { label: "38", id: 776 },
      { label: "38.5", id: 777 },
      { label: "39", id: 778 },
      { label: "39.5", id: 779 },
      { label: "40", id: 780 },
      { label: "40.5", id: 781 },
      { label: "41", id: 782 },
      { label: "41.5", id: 783 },
      { label: "42", id: 784 },
      { label: "42.5", id: 785 },
      { label: "43", id: 786 },
      { label: "43.5", id: 787 },
      { label: "44", id: 788 },
      { label: "44.5", id: 789 },
      { label: "45", id: 790 },
      { label: "45.5", id: 791 },
      { label: "46", id: 792 },
      { label: "46.5", id: 793 },
      { label: "47", id: 794 },
      { label: "47.5", id: 795 },
      { label: "48", id: 1190 },
      { label: "48.5", id: 1621 },
    ],
  },
  {
    key: "77",
    label: "Jeans (W23–W54)",
    sizes: [
      { label: "W23", id: 1631 },
      { label: "W24", id: 1632 },
      { label: "W25", id: 1633 },
      { label: "W26", id: 1634 },
      { label: "W27", id: 1635 },
      { label: "W28", id: 1636 },
      { label: "W29", id: 1637 },
      { label: "W30", id: 1638 },
      { label: "W31", id: 1639 },
      { label: "W32", id: 1640 },
      { label: "W33", id: 1641 },
      { label: "W34", id: 1642 },
      { label: "W35", id: 1662 },
      { label: "W36", id: 1643 },
      { label: "W38", id: 1644 },
      { label: "W40", id: 1645 },
      { label: "W42", id: 1646 },
      { label: "W44", id: 1647 },
      { label: "W46", id: 1648 },
      { label: "W48", id: 1649 },
      { label: "W50", id: 1704 },
      { label: "W52", id: 1705 },
      { label: "W54", id: 1706 },
    ],
  },
  {
    key: "32",
    label: "Kinder Kleidung (0 Mon.–16 J.)",
    sizes: [
      { label: "Frühchen", id: 610 },
      { label: "Neugeboren / 44cm", id: 666 },
      { label: "0–1 Mon. / 50cm", id: 612 },
      { label: "1–3 Mon. / 56cm", id: 613 },
      { label: "3–6 Mon. / 62cm", id: 614 },
      { label: "6–9 Mon. / 68cm", id: 616 },
      { label: "9–12 Mon. / 74cm", id: 617 },
      { label: "12–18 Mon. / 80cm", id: 618 },
      { label: "18–24 Mon. / 86cm", id: 619 },
      { label: "2–3 J. / 92cm", id: 622 },
      { label: "3 J. / 98cm", id: 1567 },
      { label: "4 J. / 104cm", id: 623 },
      { label: "5 J. / 110cm", id: 624 },
      { label: "6 J. / 116cm", id: 625 },
      { label: "7 J. / 122cm", id: 626 },
      { label: "8 J. / 128cm", id: 627 },
      { label: "9 J. / 134cm", id: 628 },
      { label: "10 J. / 140cm", id: 629 },
      { label: "11 J. / 146cm", id: 630 },
      { label: "12 J. / 152cm", id: 631 },
      { label: "13 J. / 158cm", id: 632 },
      { label: "14 J. / 164cm", id: 633 },
      { label: "15 J. / 170cm", id: 634 },
      { label: "16 J. / 176cm", id: 635 },
    ],
  },
  {
    key: "31",
    label: "Kinder Schuhe (15–40)",
    sizes: [
      { label: "15", id: 657 },
      { label: "16", id: 585 },
      { label: "17", id: 586 },
      { label: "18", id: 587 },
      { label: "19", id: 588 },
      { label: "20", id: 589 },
      { label: "21", id: 590 },
      { label: "22", id: 591 },
      { label: "23", id: 592 },
      { label: "24", id: 593 },
      { label: "25", id: 594 },
      { label: "26", id: 595 },
      { label: "27", id: 596 },
      { label: "28", id: 597 },
      { label: "29", id: 598 },
      { label: "30", id: 599 },
      { label: "31", id: 600 },
      { label: "32", id: 601 },
      { label: "33", id: 602 },
      { label: "34", id: 603 },
      { label: "35", id: 604 },
      { label: "36", id: 605 },
      { label: "37", id: 606 },
      { label: "38", id: 607 },
      { label: "39", id: 608 },
      { label: "40", id: 609 },
    ],
  },
];

export function getSizeLabel(id: string): string {
  const numId = Number(id);
  for (const group of SIZE_GROUPS) {
    const found = group.sizes.find((s) => s.id === numId);
    if (found) return found.label;
  }
  return id;
}

export function getSizeLabels(sizeId: string | null | undefined): string[] {
  if (!sizeId) return [];
  return sizeId
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(getSizeLabel);
}
