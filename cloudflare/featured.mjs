export const featuredItemId = 1284;
export const featuredPreviewUri = "/featured/item-1284.png";

export const featuredHistory = [
  {
    "ItemId": 10002,
    "FeaturedAt": "2026-09-07T23:04:06.000Z"
  },
  {
    "ItemId": 726,
    "FeaturedAt": "2026-09-14T15:51:33.000Z"
  },
  {
    "ItemId": 749,
    "FeaturedAt": "2026-09-20T02:47:43.000Z"
  },
  {
    "ItemId": 705,
    "FeaturedAt": "2026-09-27T20:42:52.165Z"
  },
  {
    "ItemId": 1284,
    "FeaturedAt": "2026-10-06T15:02:21.004Z"
  }
];

export function isFeaturedItemId(id) {
  return Number.isSafeInteger(featuredItemId) && Number(id) === featuredItemId;
}

export function applyFeaturedItem(item, selectedId = featuredItemId, history = featuredHistory) {
  const featured = Number.isSafeInteger(selectedId) && Number(item.Id) === selectedId;
  const featureDates = history.filter((entry) => Number(entry.ItemId) === Number(item.Id)).map((entry) => entry.FeaturedAt);
  const result = { ...item, Featured: featured, FeatureDates: featureDates, FeaturedCount: featureDates.length, PreviouslyFeatured: featureDates.length > 0 };
  return featured
    ? { ...result, PreviewUri: selectedId === featuredItemId && featuredPreviewUri ? featuredPreviewUri : `/featured/item-${selectedId}.png` }
    : result;
}

export function compareFeaturedItems(left, right) {
  return Number(Boolean(right.Featured)) - Number(Boolean(left.Featured));
}
