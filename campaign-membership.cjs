"use strict";
const campaignLinks = require("./campaign-level-links.json");

function payloadMatches(item, snapshot) {
  return Boolean(item && snapshot && item.PayloadUri === snapshot.Uri
    && Number(item.PayloadLength) === Number(snapshot.Length));
}

function snapshot(item) {
  return { Uri: item.PayloadUri, Length: Number(item.PayloadLength) };
}

function buildCampaignMemberships(items, records) {
  const byId = new Map(items.map((item) => [Number(item.Id), item]));
  const valid = records.filter((record) => record.FingerprintVersion === 2
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
  return links.sort((a, b) => a.LevelId - b.LevelId || a.CampaignId - b.CampaignId);
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

module.exports = { buildCampaignMemberships, campaignsForLevel };
