import type { CategoryViewId, MainViewId, ViewId } from "../types";

const categoryPrefix = "category:";

export function createCategoryViewId(categoryId: string): CategoryViewId {
  return `${categoryPrefix}${categoryId}`;
}

export function getCategoryIdFromView(view: ViewId): string | null {
  return view.startsWith(categoryPrefix) ? view.slice(categoryPrefix.length) : null;
}

export function getMainViewFromView(view: ViewId): MainViewId | null {
  return getCategoryIdFromView(view) ? null : (view as MainViewId);
}
