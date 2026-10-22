"use strict";
const campaignLinks = require("./campaign-level-links.json");

function payloadMatches(item, snapshot) {
  return Boolean(item && snapshot && item.PayloadUri === snapshot.Uri
    && Number(item.PayloadLength) === Number(snapshot.Length));
}

function snapshot(item) {
  return { Uri: item.PayloadUri, Length: Number(item.PayloadLength) };
}

function buildCampaignMemberships(items, records, approvedLinks = []) {
  const byId = new Map(items.map((item) => [Number(item.Id), item]));
  const valid = records.filter((record) => (record.FingerprintVersion === 2
    || (record.Components?.length > 0 && record.Components.every((part) => part.TokenCount > 0)))
    && payloadMatches(byId.get(Number(record.ItemId)), { Uri: record.PayloadUri, Length: record.PayloadLength }));
  const playable = (record) => (record.Components || []).filter((part) => part.Kind === "level"
    && part.TokenCount >= 4 && !/(^|\/)(?:blocks|backups?|__macosx)(\/|$)/i.test(String(part.Path).replaceAll("\\", "/")));
  const campaignParts = valid.filter((record) => byId.get(Number(record.ItemId)).ResourceType === 2)
    .flatMap((record) => playable(record).map((part) => ({ ...part, CampaignId: Number(record.ItemId) })));
  const links = [];
  for (const record of valid) {
    const level = byId.get(Number(record.ItemId));
    if (level.ResourceType !== 0) continue;
    const parts = playable(record);
    const campaigns = new Map();
    for (const part of campaignParts) {
      const exact = parts.some((other) => other.CanonicalHash && other.CanonicalHash === part.CanonicalHash);
      const layout = parts.some((other) => other.LayoutHash && other.LayoutHash === part.LayoutHash);
      if (!exact && !layout) continue;
      const existing = campaigns.get(part.CampaignId);
      if (existing && (existing.Match === "content" || !exact)) continue;
      const campaign = byId.get(part.CampaignId);
      campaigns.set(campaign.Id, {
        LevelId: level.Id, CampaignId: campaign.Id, Match: exact ? "content" : "layout",
        LevelPayload: snapshot(level), CampaignPayload: snapshot(campaign),
      });
    }
    links.push(...campaigns.values());
  }
  for (const approved of approvedLinks) {
    const level = byId.get(Number(approved.LevelId));
    const campaign = byId.get(Number(approved.CampaignId));
    if (level?.ResourceType !== 0 || campaign?.ResourceType !== 2 || approved.Match !== "variant"
      || !payloadMatches(level, approved.LevelPayload) || !payloadMatches(campaign, approved.CampaignPayload)) continue;
    if (!links.some((link) => link.LevelId === level.Id && link.CampaignId === campaign.Id)) links.push(approved);
  }
  return links.sort((a, b) => a.LevelId - b.LevelId || a.CampaignId - b.CampaignId);
}

function mergeCampaignMemberships(items, existingLinks, newLinks, excludedPairs = []) {
  const byId = new Map(items.map((item) => [Number(item.Id), item]));
  const key = (link) => `${Number(link.LevelId)}:${Number(link.CampaignId)}`;
  const excluded = new Set(excludedPairs.map(key));
  const merged = new Map();
  // Preserve existing decisions first. A missing or interrupted scan must not
  // erase established links; changed payloads still need fresh evidence.
  for (const link of [...existingLinks, ...newLinks]) {
    const level = byId.get(Number(link.LevelId));
    const campaign = byId.get(Number(link.CampaignId));
    if (excluded.has(key(link)) || merged.has(key(link)) || level?.ResourceType !== 0 || campaign?.ResourceType !== 2
      || !payloadMatches(level, link.LevelPayload) || !payloadMatches(campaign, link.CampaignPayload)) continue;
    merged.set(key(link), link);
  }
  return [...merged.values()].sort((a, b) => a.LevelId - b.LevelId || a.CampaignId - b.CampaignId);
}

function campaignsForLevel(item, items, isHidden = () => false, document = campaignLinks) {
  if (item.ResourceType !== 0 || isHidden(item.Id)) return [];
  const byId = new Map(items.map((candidate) => [Number(candidate.Id), candidate]));
  return (document.Links || []).filter((link) => {
    const campaign = byId.get(Number(link.CampaignId));
    return Number(link.LevelId) === Number(item.Id) && campaign?.ResourceType === 2
      && !isHidden(campaign.Id) && payloadMatches(item, link.LevelPayload)
      && payloadMatches(campaign, link.CampaignPayload);
  }).map((link) => ({ Id: Number(link.CampaignId), Match: link.Match }));
}

module.exports = { buildCampaignMemberships, mergeCampaignMemberships, campaignsForLevel };
