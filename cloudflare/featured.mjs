export const featuredItemId = null;
export const featuredPreviewUri = "";

export function isFeaturedItemId(id) {
  return Number.isSafeInteger(featuredItemId) && Number(id) === featuredItemId;
}

export function applyFeaturedItem(item, selectedId = featuredItemId) {
  const featured = Number.isSafeInteger(selectedId) && Number(item.Id) === selectedId;
  return featured
    ? { ...item, Featured: true, PreviewUri: featuredPreviewUri || `/featured/item-${selectedId}.png` }
    : { ...item, Featured: false };
}

export function compareFeaturedItems(left, right) {
  return Number(Boolean(right.Featured)) - Number(Boolean(left.Featured));
}
