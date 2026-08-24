export const items = [
  {
    Id: 1,
    Name: "Shuriken Race",
    ResourceType: 0,
    TimeStamp: 1787324069,
    AuthorId: 0,
    AuthorName: "Adifo",
    PreviewUri: "/previews/shuriken-race.jpg",
    PayloadUri: "/payloads/shuriken-race.zip",
    Description: "A custom Marble Race level.",
    PayloadLength: 385028,
    Version: "0.0",
    Tags: ["shuriken", "race"],
    Downloads: 0,
    Rating: 0,
  },
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
