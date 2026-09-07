export const featuredItemId = 10002;
export const featuredPreviewUri = "/featured/item-10002.png";

export function isFeaturedItemId(id) {
  return Number.isSafeInteger(featuredItemId) && Number(id) === featuredItemId;
}

export function applyFeaturedItem(item, selectedId = featuredItemId) {
  const featured = Number.isSafeInteger(selectedId) && Number(item.Id) === selectedId;
  return featured
    ? { ...item, Featured: true, PreviewUri: selectedId === featuredItemId && featuredPreviewUri ? featuredPreviewUri : `/featured/item-${selectedId}.png` }
    : { ...item, Featured: false };
}

export function compareFeaturedItems(left, right) {
  return Number(Boolean(right.Featured)) - Number(Boolean(left.Featured));
}
