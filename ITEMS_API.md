# Marble Race Items API

Base URL: `https://marbleraceapi.azurewebsites.net/api`

## GET `/Items`

Returns a filtered list of items. Authentication is not required.

### Query parameters

| Name | Type | Required | Default | Description |
|---|---|---:|---:|---|
| `search` | string | No | — | Matches item names and tags. |
| `skip` | int32 | No | `0` | Number of items to skip. |
| `limit` | int32 | No | `10` | Maximum items to return. |
| `type` | string | No | — | Item type or comma-separated types, such as `0,1,2`. |
| `itemVersion` | string | No | — | Required item/build version. |
| `sort` | string | No | `popular` | `popular`, `top`, `new`, or `old`. |
| `timeFrom` | int64 | No | — | Created after this Unix timestamp in seconds. |
| `timeTo` | int64 | No | — | Created before this Unix timestamp in seconds. |

Known item types:

| Value | Type |
|---:|---|
| `0` | Level |
| `1` | Block |
| `2` | Campaign |

### Example

```http
GET https://marbleraceapi.azurewebsites.net/api/Items?search=track&type=0,2&sort=new&skip=0&limit=10
```

```bash
curl --get \
  --data-urlencode "search=track" \
  --data-urlencode "type=0,2" \
  --data-urlencode "sort=new" \
  --data-urlencode "skip=0" \
  --data-urlencode "limit=10" \
  "https://marbleraceapi.azurewebsites.net/api/Items"
```

### Response

`200 OK` with a JSON array of [Item](#item).

```json
[
  {
    "Id": 723,
    "Name": "Minecraft Pink A",
    "ResourceType": 2,
    "TimeStamp": 1784572602,
    "AuthorId": 0,
    "AuthorName": "Elastic Sea",
    "PreviewUri": "https://example.com/723.png",
    "PayloadUri": "https://example.com/723.zip",
    "Description": "A community campaign.",
    "PayloadLength": 4777758,
    "Version": "1.2.3"
  }
]
```

## GET `/GetItem`

Returns one item by ID.

### Query parameters

| Name | Type | Required | Description |
|---|---|---:|---|
| `id` | int64 | Yes | Item ID returned by `/Items`. |

### Example

```http
GET https://marbleraceapi.azurewebsites.net/api/GetItem?id=698
```

```bash
curl "https://marbleraceapi.azurewebsites.net/api/GetItem?id=698"
```

### Responses

| Status | Response |
|---:|---|
| `200` | One [Item](#item). |
| `404` | Item not found. |

## Item

| Field | Type | Description |
|---|---|---|
| `Id` | int64 | Item ID. |
| `Name` | string | Item name. |
| `ResourceType` | int32 | Item type. |
| `TimeStamp` | int64 | Unix timestamp in seconds. |
| `AuthorId` | int64 | Author ID. |
| `AuthorName` | string | Author name. |
| `PreviewUri` | URI | Preview image URL. |
| `PayloadUri` | URI | Payload download URL. |
| `Description` | string | Item description. |
| `PayloadLength` | int32 | Payload size. |
| `Version` | string | Item version. |
