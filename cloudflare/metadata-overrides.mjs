export const metadataOverrides = new Map([]);

export function applyMetadataOverrides(item) {
  const override = metadataOverrides.get(Number(item.Id));
  return override ? { ...item, ...override } : item;
}
