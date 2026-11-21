# EarthWalk protocol

How the game client talks to the world server. The server is the reference
implementation (`server/src`); the browser client (`server/public`) and the Unreal
client (`game/Source/EarthWalk`) both speak it, so their players share the same rooms.

## Coordinates

The world is cut into **chunks**: Web Mercator map tiles at zoom 16 (the same `x`/`y`
numbering as OpenStreetMap tiles). A chunk is about 610 m across at the equator and
430 m at 45° latitude.

A client picks an origin latitude/longitude (where the player is). With
`S = 40075016.686 × cos(originLat) / 65536` (metres per chunk), a point at fractional
tile coordinates `(tx, ty)` is `(tx − originTx) × S` metres east and
`−(ty − originTy) × S` metres north of the origin. Heights are metres above sea level.
The scale is only exact at the origin's latitude, so clients re-centre when the player
travels far.

## Access code and player tokens

If the server was started with `EARTHWALK_ACCESS_CODE`, the chunk and place-search requests
need it as `Authorization: Bearer <code>` (or `?code=<code>`), and the meetup `hello` needs it
as `token`. Without it they answer `401`. `GET /health` is always open and reports
`codeRequired` and `googleSignIn`.

A **player token** stands in for the access code everywhere the code is accepted. It is a
long random string the server hands to someone who signed in with Google (below); the server
keeps only its hash. The browser carries it in an `HttpOnly` cookie (`ew_token`), which also
travels with the WebSocket upgrade, so a signed-in browser sends no `token` in `hello`. The
Unreal game sends it as the Bearer header and as `hello.token`. Guests with the access code
keep working exactly as before.

A caller that asks for too many not-yet-built chunks in a short time gets `429` with a
`Retry-After` header.

## Chunks: `GET /v1/chunk/16/{x}/{y}`

Returns a binary "EWC1" file, little-endian:

| Field | Type | Notes |
| --- | --- | --- |
| magic | u32 | `0x31435745` (`"EWC1"`) |
| version | u32 | `1` |
| x, y | u32, u32 | chunk tile numbers |
| metersPerTile | f32 | chunk size at the chunk's own latitude (informational) |
| sectionCount | u32 | |

Then `sectionCount` sections, each:

| Field | Type | Notes |
| --- | --- | --- |
| materialId | u32 | 0–8 ground types, 10–13 roads/paths/rail/streams, 20–28 buildings, 30 trees |
| color | u32 | `0xRRGGBBAA`, sRGB |
| flags | u32 | bit 0: the player collides with this section |
| vertexCount | u32 | |
| indexCount | u32 | multiple of 3 |
| positions | f32 × 3 × vertexCount | `u` (0 = west edge, 1 = east edge), `v` (0 = north edge, 1 = south edge), height in metres |
| normals | f32 × 3 × vertexCount | east, north, up |
| indices | u32 × indexCount | triangles, counter-clockwise seen from the front in an (east, north, up) right-handed frame |

`u`/`v` may fall slightly outside 0–1 (buildings belong to the chunk holding their
centre; roads overlap chunk edges a little so they join up).

Buildings: the id says what a surface is and the colour says what paint it has, so one id can
come in several sections, one per colour (sections are ordered by id, then colour, and no pair
repeats). 20 painted house walls, 21 large painted walls, 22 large concrete walls, 23 brick
house walls; 24 and 25 roofs; 26 doors (no collision); 27 woodwork such as door frames, steps,
porch posts, chimney caps and the undersides of eaves (no collision); 28 chimneys (no
collision). A client that does not know an id can draw it in its colour. Homes (small buildings
that are not garages, sheds or shops) get a door on the wall facing the nearest road.

## Labels: `GET /v1/labels/16/{x}/{y}`

House numbers and street names for the same chunk, as JSON. The route is **optional**: a
client that ignores it still gets the complete world from the chunk meshes. It takes the
same access code, zoom and rate-limit rules as the chunk route, and the same `x`/`y`
numbering. Both clients plant their trees from it (and skip mesh section 30); the Unreal
client also spawns letterboxes and sign posts from it.

```json
{"x": 33185, "y": 22545, "rev": 1,
 "items": [
   {"kind": "house", "text": "12", "u": 0.4, "v": 0.5035, "h": 61.2, "yaw": 180},
   {"kind": "street", "text": "Rue de Rivoli", "text2": "Rue du Louvre", "u": 0.51, "v": 0.7, "h": 60.9, "yaw": 90, "yaw2": 0}
 ]}
```

| Field | Meaning |
| --- | --- |
| `rev` | Placement revision; bumps when the server lays labels out differently. |
| `kind` | `house` (a letterbox plate), `street` (a sign post) or `tree`. |
| `text`, `text2` | The plate text (absent on trees). A `street` item at a crossing has two plates, `text2` being the second street; a street with no crossing nearby has only `text`. |
| `s`, `r`, `c` | Trees only: height and canopy radius in metres, and `c` = 1 for a conifer. Trees are the same ones the chunk mesh draws as cones (surface id 30), so a client with its own tree models skips that section and plants these instead. At most 1500 per chunk, thinned evenly. |
| `u`, `v` | Position across the chunk, as in the meshes: `u` 0 = west edge, 1 = east edge; `v` 0 = north edge, 1 = south edge. May fall slightly outside 0–1 for buildings that straddle the chunk edge. |
| `h` | Terrain-mesh height at the point, in metres above sea level, so the prop stands on the ground. |
| `yaw`, `yaw2` | Compass heading in degrees (0 north, 90 east) that the text of `text` / `text2` faces. |

Placement: a house plate stands 1.5 m from the building corner nearest its street
(`addr:street` if mapped, else the nearest named road within 120 m), facing that road.
A crossing sign stands on the corner of the junction with the most room, each plate
facing back across its own street. A street with no crossing in the area gets one plate
halfway along its piece of the chunk. At most 120 house and 40 street items per chunk.

## Place search: `GET /v1/geocode?q=...`

`200 {"name": "...", "lat": 48.85, "lon": 2.29}` or `404`. `q` may also be `"lat, lon"`.

## Sign in with Google

Offered only when the server has `EARTHWALK_GOOGLE_CLIENT_ID` and `_SECRET` (see
docs/HOSTING.md); otherwise these routes answer `404` and `/health` says `"googleSignIn": false`.

| Route | Meaning |
| --- | --- |
| `GET /auth/google?code=<access code>&next=/` | Sends the browser to Google. `code` (optional) is the shared access code: a Google account that is not yet known is accepted only if the sign-in carries the code or its email is in `EARTHWALK_INVITED` (or the server has no access code). `next` is where to return to (same-origin paths only). |
| `GET /auth/google/callback` | Google returns here. On success the browser gets the token cookie and goes to `next`; an uninvited account is sent to `/?signin=not-invited`. |
| `POST /auth/logout` | Revokes the token in the cookie or Bearer header and clears the cookie. |
| `GET /v1/me` | Token required. `{"id","name","avatar","email","home":{"lat","lon","name"}|null,"created"}`. |
| `GET /v1/people` | Token required. `{"people":[...]}`, the same entries as the `people` message below. |

### Linking the Unreal game

The game has no browser of its own, so it signs in through one:

1. The game makes a short code (`ABCD2345`) and opens `<server>/link?code=ABCD2345&access=<access code>`
   in the system browser. That page forwards to `/auth/google` with the code attached.
2. The person signs in with Google in the browser and sees a "you can go back to the game" page.
3. Meanwhile the game polls `GET /v1/link/ABCD2345` every couple of seconds. It answers
   `{"pending":true}` until the sign-in completes, then once (and only once)
   `{"token":"...","name":"Mum","avatar":"owl"}`. The game saves the token for later launches.

Link codes are 4 to 16 letters and digits, case-insensitive, and are forgotten after ten minutes.

## Meetups: WebSocket `/v1/ws`

JSON text messages, each with a type field `t`.

Client to server:

| Message | Meaning |
| --- | --- |
| `{"t":"hello","name":"Mum","room":"family","avatar":"owl","token":"..."}` | Must be first. `avatar` is the player's animal: a short lowercase id (`fox`, `bear`, `rabbit`, `cat`, `owl`, `frog`; anything invalid becomes `fox`). Clients decide how each animal looks. `token` is the access code or a player token (or comes from the browser cookie). A signed-in client may leave out `name` and `avatar` to use the account's; when it sends them, they become the account's. |
| `{"t":"pos","lat":..,"lon":..,"alt":..,"yaw":..}` | Where I am (feet, metres above sea level; yaw is a compass heading in degrees). Send about 10 times a second. |
| `{"t":"chat","text":"hello"}` | Say something to the room. |
| `{"t":"home"}` / `{"t":"home","lat":..,"lon":..,"name":"Eiffel Tower"}` | Signed-in only. Make where I stand my home (the server names the place), or the given place. Answered with a `home` message, or `error` `guest` / `nowhere`. |
| `{"t":"people"}` | Ask for the people list again (it is also pushed whenever it changes). |

Server to client:

| Message | Meaning |
| --- | --- |
| `{"t":"welcome","id":"..","name":"..","avatar":"..","room":"..","peers":[{"id","name","avatar","lat","lon","alt","yaw"}],"history":[...],"signedIn":true,"personId":"..","home":{"lat","lon","name"}}` | You are in. `name` may differ from what you asked for if it was taken. `history` holds recent chat lines. `personId` and `home` (which may be `null`) are present only for a signed-in player; a signed-in client should start at `home` when it is set. |
| `{"t":"join","id":"..","name":"..","avatar":".."}` / `{"t":"leave","id":".."}` | Someone arrived or left. |
| `{"t":"peers","p":[[id,lat,lon,alt,yaw],...]}` | People who moved since the last update (10 per second). |
| `{"t":"chat","id":"..","name":"..","text":"..","ts":1700000000000}` | A chat line (also echoed to the sender). |
| `{"t":"people","p":[{"id","name","avatar","online","room","place","lat","lon","lastSeen","home"}]}` | Everyone with an account (guests are not listed), online first. Sent right after `welcome`, whenever someone with an account arrives or leaves or their place name changes, and on request. `room` and `place` are where they are, or were last; `lat`/`lon` (about 10 m precision) only while online; `lastSeen` is milliseconds since the epoch; `home` is the name of their home or `null`. Place names come from a reverse lookup of the position, rounded to about a kilometre and at most once every 30 s per person. |
| `{"t":"home","lat":..,"lon":..,"name":".."}` | Your home was saved. |
| `{"t":"error","code":"denied" \| "full" \| "slow" \| "guest" \| "nowhere" \| "home","text":".."}` | Something was refused. |
