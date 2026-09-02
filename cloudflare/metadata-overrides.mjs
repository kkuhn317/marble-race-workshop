export const metadataOverrides = new Map([
  [
    710,
    {
      "AuthorName": "BookwormKevin"
    }
  ],
  [
    735,
    {
      "AuthorName": "BookwormKevin"
    }
  ],
  [
    746,
    {
      "AuthorName": "BookwormKevin"
    }
  ],
  [
    797,
    {
      "AuthorName": "BookwormKevin"
    }
  ],
  [
    823,
    {
      "AuthorName": "BookwormKevin"
    }
  ],
  [
    827,
    {
      "AuthorName": "BookwormKevin"
    }
  ],
  [
    857,
    {
      "AuthorName": "BookwormKevin"
    }
  ],
  [
    873,
    {
      "AuthorName": "BookwormKevin"
    }
  ],
  [
    917,
    {
      "AuthorName": "BookwormKevin"
    }
  ],
  [
    920,
    {
      "AuthorName": "BookwormKevin"
    }
  ],
  [
    954,
    {
      "AuthorName": "BookwormKevin"
    }
  ],
  [
    999,
    {
      "AuthorName": "BookwormKevin"
    }
  ],
  [
    1002,
    {
      "AuthorName": "BookwormKevin"
    }
  ],
  [
    1266,
    {
      "AuthorName": "BookwormKevin"
    }
  ],
  [
    1291,
    {
      "AuthorName": "BookwormKevin"
    }
  ],
  [
    1296,
    {
      "AuthorName": "BookwormKevin"
    }
  ],
  [
    1304,
    {
      "AuthorName": "BookwormKevin"
    }
  ],
  [
    1318,
    {
      "AuthorName": "BookwormKevin"
    }
  ]
]);

export function applyMetadataOverrides(item) {
  const override = metadataOverrides.get(Number(item.Id));
  return override ? { ...item, ...override } : item;
}
