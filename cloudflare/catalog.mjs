export const items = [
    {
        "Id":  1,
        "Name":  "Shuriken Race",
        "ResourceType":  0,
        "TimeStamp":  1787606104,
        "AuthorId":  0,
        "AuthorName":  "Adifo",
        "PreviewUri":  "/previews/shuriken-race.jpg",
        "PayloadUri":  "https://content.marble.kevin-kuhn.dev/payloads/shuriken-race.zip",
        "Description":  "A custom Marble Race level.",
        "PayloadLength":  385028,
        "Version":  "0.0",
        "Tags":  [
                     "shuriken",
                     "race"
                 ],
        "Downloads":  0,
        "Rating":  0
    },
    {
        "Id":  990000000001,
        "Name":  "Hamsterball V 2.4.2",
        "ResourceType":  2,
        "TimeStamp":  1788278093,
        "AuthorId":  0,
        "AuthorName":  "BookwormKevin",
        "PreviewUri":  "/previews/hamsterball-v-2-4-2.png",
        "PayloadUri":  "https://content.marble.kevin-kuhn.dev/payloads/hamsterball-v-2-4-2-v2.zip",
        "Description":  "This campaign includes all of the levels in the original Hamsterball game, including secret medal times and different arena unlock locations.",
        "PayloadLength":  40558377,
        "Version":  "1.5.3",
        "Tags":  [
                     "hamsterball",
                     "campaign",
                     "recreation"
                 ],
        "Downloads":  0,
        "Rating":  0
    },
    {
        "Id":  990000000002,
        "Name":  "Kry Pack 2",
        "ResourceType":  2,
        "TimeStamp":  1787673969,
        "AuthorId":  0,
        "AuthorName":  "Kry",
        "PreviewUri":  "/previews/kry-pack-2.jpg",
        "PayloadUri":  "https://content.marble.kevin-kuhn.dev/payloads/kry-pack-2-v2.zip",
        "Description":  "Official sequel to Kry Pack.",
        "PayloadLength":  46755223,
        "Version":  "1.5.3",
        "Tags":  [
                     "campaign",
                     "kry"
                 ],
        "Downloads":  0,
        "Rating":  0
    },
    {
        "Id":  990000000003,
        "Name":  "Interlude",
        "ResourceType":  0,
        "TimeStamp":  1787673969,
        "AuthorId":  0,
        "AuthorName":  "lunosomnia",
        "PreviewUri":  "/previews/interlude.png",
        "PayloadUri":  "https://content.marble.kevin-kuhn.dev/payloads/interlude-v2.zip",
        "Description":  "A custom Marble Race level by lunosomnia.",
        "PayloadLength":  950988,
        "Version":  "1.4.17",
        "Tags":  [
                     "level",
                     "race"
                 ],
        "Downloads":  0,
        "Rating":  0
    },
    {
        "Id":  990000000004,
        "Name":  "The Embered Racing",
        "ResourceType":  0,
        "TimeStamp":  1787673969,
        "AuthorId":  0,
        "AuthorName":  "Mikey",
        "PreviewUri":  "/previews/the-embered-racing.png",
        "PayloadUri":  "https://content.marble.kevin-kuhn.dev/payloads/the-embered-racing-v2.zip",
        "Description":  "There are bowling-ball enemies on the yellow danger zones. Roll carefully: they will catch and push you.",
        "PayloadLength":  2926180,
        "Version":  "1.5.3",
        "Tags":  [
                     "level",
                     "race",
                     "bowling balls"
                 ],
        "Downloads":  0,
        "Rating":  0
    },
    {
        "Id":  990000000005,
        "Name":  "Deluxe Series",
        "ResourceType":  2,
        "TimeStamp":  1788277525,
        "AuthorId":  0,
        "AuthorName":  "Adifo",
        "PreviewUri":  "/previews/deluxe-series.jpg",
        "PayloadUri":  "https://content.marble.kevin-kuhn.dev/payloads/deluxe-series-1788277525.zip",
        "Description":  "This is my Campaign but remake by SAGYT AND ROYSCOTER AND OTHER PLAYERS IN THIS GAME. There is no time attack mode just practice play and have fun with my campaign. There would be basic teaching (starts from lv 1) that you are a pro player in this game and practice levels (starts from lv 2) and then enemies and bumpers (starts from lv 2 except 3 and 1) and then blooms (starts from lv 4) and then long levels and high jump bumpers and tricky force zones (Starts from canyon Race) after that you play all the levels. It means that you are a pro player of Marble Race.",
        "PayloadLength":  16643106,
        "Version":  "1.4.17",
        "Tags":  [
                     "campaign"
                 ],
        "Downloads":  0,
        "Rating":  0
    },
    {
        "Id":  990000000006,
        "Name":  "Kry Pack 3",
        "ResourceType":  2,
        "TimeStamp":  1788281477,
        "AuthorId":  0,
        "AuthorName":  "Kry",
        "PreviewUri":  "/previews/kry-pack-3.jpg",
        "PayloadUri":  "https://content.marble.kevin-kuhn.dev/payloads/kry-pack-3-1788281477.zip",
        "Description":  "Official sequel to Kry Pack 2.",
        "PayloadLength":  22022936,
        "Version":  "1.5.2",
        "Tags":  [
                     "campaign"
                 ],
        "Downloads":  0,
        "Rating":  0
    },
    {
        "Id":  990000000007,
        "Name":  "Rcubed Pack 3.0",
        "ResourceType":  2,
        "TimeStamp":  1788282142,
        "AuthorId":  0,
        "AuthorName":  "Rcube",
        "PreviewUri":  "/previews/rcubed-pack-3-0.png",
        "PayloadUri":  "https://content.marble.kevin-kuhn.dev/payloads/rcubed-pack-3-0-1788282142.zip",
        "Description":  "Enjoy My 10 Marble Race Level on each Campaign Level with different type of challenges including some Arena and Secret Level (Coming Soon)",
        "PayloadLength":  148003685,
        "Version":  "1.4.17",
        "Tags":  [
                     "campaign"
                 ],
        "Downloads":  0,
        "Rating":  0
    }
];

export function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
  });
}

export function publicItem(item, requestUrl) {
  const origin = new URL(requestUrl).origin;
  return {
    Id: item.Id,
    Name: item.Name,
    ResourceType: item.ResourceType,
    TimeStamp: item.TimeStamp,
    AuthorId: item.AuthorId,
    AuthorName: item.AuthorName,
    PreviewUri: new URL(item.PreviewUri, origin).toString(),
    PayloadUri: new URL(item.PayloadUri, origin).toString(),
    Description: item.Description,
    PayloadLength: item.PayloadLength,
    Version: item.Version,
  };
}
