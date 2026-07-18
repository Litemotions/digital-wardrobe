export type Category =
  | "top"
  | "bottom"
  | "dress"
  | "outerwear"
  | "shoes"
  | "accessory";

export const CATEGORIES: { id: Category; label: string; emoji: string }[] = [
  { id: "top", label: "Tops", emoji: "👕" },
  { id: "bottom", label: "Bottoms", emoji: "👖" },
  { id: "dress", label: "Dresses", emoji: "👗" },
  { id: "outerwear", label: "Outerwear", emoji: "🧥" },
  { id: "shoes", label: "Shoes", emoji: "👟" },
  { id: "accessory", label: "Accessories", emoji: "👜" },
];

export function categoryLabel(id: Category): string {
  return CATEGORIES.find((c) => c.id === id)?.label ?? id;
}

export function categoryEmoji(id: Category): string {
  return CATEGORIES.find((c) => c.id === id)?.emoji ?? "🧺";
}

// Images are a Blob in local (on-device) mode, or a URL string in cloud mode.
export type ImageSrc = Blob | string;

export interface ClothingItem {
  id: string;
  name: string;
  category: Category;
  color?: string;
  image: ImageSrc;
  createdAt: number;
}

export interface ModelPhoto {
  id: string;
  name: string;
  image: ImageSrc;
  createdAt: number;
}

export interface Look {
  id: string;
  name: string;
  modelId: string;
  itemIds: string[];
  result: ImageSrc;
  createdAt: number;
}
