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
| materialId | u32 | 0–8 ground types, 10–15 roads/paths/rail/streams/pavements/markings, 20–28 buildings, 30 trees, 32–33 hedges and fences |
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

Streets and gardens: 14 pavements, laid beside roads where the ground is residential or paved
or buildings stand within about 40 m, a little lower than the road so that crossing roads cover
them; 15 road markings; 32 hedges and 33 fences round front gardens, whose paths are ordinary
path sections (11). None of these collide.

## Labels: `GET /v1/labels/16/{x}/{y}`

House numbers and street names for the same chunk, as JSON. The route is **optional**: a
client that ignores it still gets the complete world from the chunk meshes. It takes the
same access code, zoom and rate-limit rules as the chunk route, and the same `x`/`y`
numbering. Both clients plant their trees from it (and skip mesh section 30); the Unreal
client also spawns letterboxes and sign posts from it. The browser client brings the
animals to life from it (see "Life" below).

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
| `kind` | `house` (a letterbox plate), `street` (a sign post), `tree`, or `home` (where a herd or flock lives), `car` (a parked car), `route` (a trip a car makes) or `train`. A client skips kinds it does not know. |
| `w`, `left`, `da`, `db`, `pts` | Routes; see "Traffic". Trains have `da`, `db` and `pts` too; see "Trains". Cars, routes and trains also carry an `id`. At most 60 cars and 14 routes per chunk. |
| `sp`, `n`, `r`, `id` | Homes only: the animal (one of those listed under "Life"), how many, the radius in metres of the circle they roam in (for `bird`, of the ring the flock flies), and the home's identity (a whole number from 1 to 4294967295, the same on every visit). Per chunk, at most 40 farm homes with 150 animals, 40 other homes with 120 animals, and one flock. A client skips animals it does not know. |
| `text`, `text2` | The plate text (absent on trees and homes). A `street` item at a crossing has two plates, `text2` being the second street; a street with no crossing nearby has only `text`. |
| `s`, `r`, `c` | Trees only: height and canopy radius in metres, and `c` = 1 for a conifer. Trees are the same ones the chunk mesh draws as cones (surface id 30), so a client with its own tree models skips that section and plants these instead. At most 1500 per chunk, thinned evenly. |
| `u`, `v` | Position across the chunk, as in the meshes: `u` 0 = west edge, 1 = east edge; `v` 0 = north edge, 1 = south edge. May fall slightly outside 0–1 for buildings that straddle the chunk edge. |
| `h` | Terrain-mesh height at the point, in metres above sea level, so the prop stands on the ground. |
| `yaw`, `yaw2` | Compass heading in degrees (0 north, 90 east) that the text of `text` / `text2` faces. |

Placement: a house plate stands 1.5 m from the building corner nearest its street
(`addr:street` if mapped, else the nearest named road within 120 m), facing that road.
A crossing sign stands on the corner of the junction with the most room, each plate
facing back across its own street. A street with no crossing in the area gets one plate
halfway along its piece of the chunk. At most 120 house and 40 street items per chunk.

## Life: animals

The server only says where a herd, a flock or a pet lives. It runs nothing while people play: every client works
out where each animal is from the home's `id` and the **shared clock** (the `now` of `welcome`
and `time` in the meetup messages below), so everyone in a room sees the same animal in the same
place, whenever they arrived. The reference is `server/public/js/lifemotion.js` (checked by
`server/test/life.test.ts`); another client must give the same answers.

Where farm homes are put (`server/src/life.ts`): on meadows (`landuse=meadow`), in paddocks
(`landuse=animal_keeping`) and farmyards, and on farmland only within 150 m of a farm building,
since most mapped farmland is crops. A barn with no mapped yard gets a few chickens beside it.
One kind of animal per field; a field's `animal_keeping`, `livestock` or `animal` tag decides it
when present. The roam circle lies inside its field and is clear by 3 m of buildings, roads,
railways, streams, water and woods, so a client need not check the ground. Footpaths may cross it.

The other animals, by the ground under a home:

| Animal | Where |
| --- | --- |
| `duck` | Ponds and lakes within 60 m of the bank, and rivers and canals at least 7 m wide. Never the sea or a bay. |
| `pigeon` | Open paved or built-up ground. |
| `bird` | A flock circling 32 to 50 m up, over about half the chunks, anywhere. |
| `cat`, `dog` | Beside one home in four, in a patch 2 to 4 m across, clear of walls by 1 m. |
| `rabbit` | Grass. |
| `deer` | Open ground within 60 m of a wood. |
| `squirrel` | Under some trees that stand on grass (not in Australia). |
| `kangaroo` | Australia: in place of deer, and on some grass. |
| `llama` | The Andes, on open ground above 2000 m. |
| `camel` | Sand, from the Sahara to the Thar (latitude 12 to 36, longitude -17 to 75). |
| `penguin` | Sand south of latitude -33. |
| `tractor` | A clear patch of ploughed farmland, 12 to 28 m across. One to a home. |
| `boat`, `sailboat` | Water within 250 m of a shore, the sea included: a sailing boat where there is a clear 14 m round it, a rowing boat where there is 6 m. One to a home. At most 8 tractors and boats per chunk. |

The rule, with `hash32(a, b)` as in `server/src/geo.ts`, `unit(a, b) = hash32(a, b) / 2^32`, and
`disc(seed, n)` a point of the unit disc: `rad = sqrt(unit(seed, 2n))`, `ang = 2π × unit(seed, 2n + 1)`,
`(rad × cos(ang), rad × sin(ang))`, x east and y south, with `n` taken modulo 2^30:

- Animal `k` (from 0) of a home has identity `A = hash32(id, k + 1)`.
- Per animal: seconds per step, the share of a step spent walking, and walking pace in m/s.
  Cow 24, 0.35, 0.8. Sheep 18, 0.35, 0.9. Horse 20, 0.4, 1.4. Chicken 5, 0.45, 1.1.
  Duck 9, 0.6, 0.45 (the same rule, on water). Pigeon 4, 0.5, 0.5. Cat 30, 0.2, 0.9. Dog 9, 0.45, 1.5.
  Rabbit 7, 0.3, 1.6. Deer 22, 0.35, 1.1. Squirrel 4, 0.45, 1.5. Kangaroo 16, 0.3, 2.0.
  Llama 22, 0.35, 0.9. Camel 26, 0.35, 0.9. Penguin 8, 0.5, 0.5.
- `patch = min(pace × walk × step / 2, r / 2)`, `room = r − patch`,
  `drift = min(0.4 × room, 0.75 × pace × walk × step)`, `spread = room − drift`.
- The animal's resting place for step `n`, in metres from the home's centre, is
  `drift × disc(hash32(id, 0x464f4355), floor(n / 8)) + spread × disc(hash32(A, 0x53504f54), 0) + patch × disc(A, n)`:
  a point the herd shares, which moves every 8 steps; the animal's own place in the herd; and a
  small shuffle. It is always within `r` of the centre.
- At shared time `t` seconds: `q = (t + unit(A, 0x50484153) × step) / step`, `n = floor(q)`,
  `f = q − n`. While `f < 1 − walk` the animal stands at place `n`, facing the way it last walked,
  with its head down to graze when `unit(A, n xor 0x47524153) < 0.7`. After that it walks to place
  `n + 1`: with `g = (f − (1 − walk)) / walk`, it is `g² × (3 − 2g)` of the way there.
- Voices: time is cut into slots of 3 s, `slot = floor(t / 3)`. An animal calls in a slot when
  `hash32(A, slot xor 0x43414c4c) mod c = 0` (`c`: cow 14, sheep 11, horse 30, chicken 5, duck 9,
  pigeon 8, cat 40, dog 25, penguin 12, bird 10; the others have no voice), at
  `t = (slot + unit(A, slot + 1)) × 3`. Everyone hears the same animal at the same moment.
- The flock (`bird`) has its own rule. With `seed = hash32(id, 0x464c4f43)`, `turn(s) = 2π × ((t / s) mod 1)`
  and a pace of 9 m/s: the flock flies a ring round the home's centre, clockwise when `seed` is odd,
  at angle `a = ±turn(2π × 0.7r / 9) + 2π × unit(seed, 1)` and radius
  `r × (0.6 + 0.15 × sin(turn(47) + 2π × unit(seed, 2)))`. Bird `k` trails the leader (bird 0) in a V:
  `row = ceil(k / 2)`, it is `row × 2.4 + 0.5 × sin(turn(3.1) + k)` metres behind along the direction
  of flight and `row × 1.7` metres further out (odd `k`) or in (even `k`). Its height above the
  ground at the home's centre is `32 + 18 × unit(seed, 3) + 2.5 × sin(turn(11) + 1.3k)` metres.

- Tractors and boats go round their home. With `seed = hash32(id, 0x4c415053)`, an oval `a = 0.85r` long
  and `b = 0.5r` wide is turned by `2π × unit(seed, 2)`; its length is taken as
  `π × (3(a + b) − sqrt((3a + b)(a + 3b)))`. The machine is at angle
  `±turn(length / pace) + 2π × unit(seed, 1)` round it (plus when `seed` is odd), at
  `(a × cos, b × sin)` before the turn. Pace: tractor 1.6 m/s, rowing boat 0.5, sailing boat 1.4. A tractor
  putts every 6 s or so (`c` = 2).

What an animal does when a player comes near (lifting its head, stepping aside, a dog trotting
over, pigeons flying up, an alarm call) is not part of the rule. Nor is a tractor stopping for
someone in front of it: it waits, then makes up the time. Each client works it out from the player positions it already has, as a
short offset from the place above that fades away again, so players agree closely but not exactly.

Sounds are made by code on each client; nothing is sent for them.

## Traffic

Cars are in the labels too. A `car` item is a parked car: its position is already at the kerb and
`yaw` is the way it faces. A `route` item is one car and the trip it makes, out and back, for ever:

```json
{"kind": "route", "id": 2863311530, "u": 0.41235, "v": 0.5, "h": 61.2, "yaw": 0,
 "w": 6, "left": 0, "da": 95, "db": 40,
 "pts": [0.41235, 0.5, 0, 0.42229, 0.5, 2.9, 0.43223, 0.5, 4.4]}
```

| Field | Meaning |
| --- | --- |
| `pts` | The middle of the road the car follows, as `u`, `v`, seconds since setting off, three numbers a point, a point every 4 m or so. `u` and `v` are as everywhere else and may run well outside 0 to 1: a trip is 60 to 420 m long and can leave its chunk. |
| `w` | The width in metres of the narrowest road on the way. |
| `left` | 1 where people drive on the left (`drivesLeft` in `server/src/traffic.ts`: rough boxes round the countries that do). |
| `da`, `db` | Seconds the car waits at the start and at the far end. |

The server builds the trips (`server/src/traffic.ts`): a car parked on a street where people live sets
off away from the way it faces, follows two-way streets (never a one-way street or a roundabout, since
it must come back the same way), mostly keeps straight on at junctions, and stops clear of one. The
times already allow for the kind of road (3 m/s on a living street to 11 on a primary road), easing off
for bends and junctions, and pulling out and in.

A client replays it (`server/public/js/trafficmotion.js` is the reference, checked by
`server/test/traffic.test.ts`). With `T` the last time in `pts`, `P = da + T + db + T` and
`τ = (t + unit(id, 0x54524950) × P) mod P`, the car is:

1. waiting at the start while `τ < da`, facing back the way it came;
2. driving out, `τ − da` seconds along the path;
3. waiting at the far end for `db` seconds, facing the way it arrived;
4. driving back, the same path and times in reverse.

Between two points it moves evenly. It faces along the road from 3 m behind it to 3 m ahead (so it
rounds corners), and keeps to one side of the middle of the road: the right of the way it faces, or
the left where `left` is 1. How far over: `kerb = max(0.6, w / 2 − 0.95)` metres when parked and
`lane = min(w / 4, kerb)` when driving. It sets off from the kerb on the *other* side (where it stood
facing the other way), so over the first 10 m of a leg it crosses from `−kerb` to `lane`, and over the
last 10 m it pulls in from `lane` to `kerb`, each with `g² × (3 − 2g)` smoothing. A client turns the
body round to its heading gradually, which is what swings the car about at each end.

A car that finds a player in front of it stops and toots; that is each client's own doing, like the
animals' reactions. It then runs a little late and makes up the time. Cars do not notice each other.

## Trains

A railway runs far beyond the piece of map a chunk is built from, so the server fetches the tracks
separately for a wide square (a zoom-13 tile, 8 by 8 chunks: `server/src/rail.ts`). Inside a square it
joins main-line tracks end to end, keeping straight on at points and cutting them at the square's
edge, and puts one train on each run of 400 m or more (the six longest at most). Tunnels and sidings
are left out. Every chunk of the square builds its trains from the same tracks, and a `train` item is
sent with **every chunk its run passes through**, identical but for where its path is measured from.
A client keeps one of each `id`.

```json
{"kind": "train", "id": 1671733423, "u": -4.99986, "v": 0.5, "h": 61.2, "yaw": 0, "da": 23, "db": 31,
 "pts": [-4.99986, 0.5, 0, -4.97, 0.5, 6.67, -4.94, 0.5, 9.43]}
```

`pts` is the track as `u`, `v`, seconds since setting off, a point every 12 m: `u` and `v` are measured
from the chunk the item came with and run far outside 0 to 1. Where the train stands at a station
(14 s, within 80 m of a `railway=station` or `halt`) the path has two points in the same place. The
times allow for a top pace of 14 m/s, easing off for bends, and gentle starts and stops.

A client replays it like a car's route (`trainPose` in `server/public/js/trafficmotion.js`), with
`τ = (t + unit(id, 0x54524149) × P) mod P`: waiting `da` seconds at the start, running out, waiting
`db` at the far end, running back by the same path and times in reverse. A train is the same at both
ends and never turns round. The browser draws four carriages of 13.6 m, 0.7 m apart, and puts the
middle of the train at `len / 2 + along × (L − len) / L` metres along the track (`len` the train's
length, `L` the track's, `along` where the timetable says it is), so the whole train stays on its run.

If the tracks cannot be fetched, the labels are sent without trains and the server does not keep that
answer, so the next request tries again. A train does not stop for players: it whistles and passes
through them.

## Place search: `GET /v1/geocode?q=...`

`200 {"name": "...", "lat": 48.85, "lon": 2.29}` or `404`. `q` may also be `"lat, lon"`.

## Where am I: `GET /v1/place?lat=...&lon=...`

`200 {"name": "Montmartre, Paris", "country": "France"}`, either of which may be `null`. For the header
that tells a player where they are. The position is rounded to two decimal places (about a kilometre)
before it is looked up, and answers are remembered, so a client may ask again whenever its own rounded
position changes. It takes the same access code as the other routes.

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
| `{"t":"ride","thing":918398760,"sp":"horse"}` / `{"t":"ride"}` | Hop on something, or (with no `thing`) hop off. See "Riding". |
| `{"t":"time","c":1234.5}` | Ask the time. `c` is any number of the client's own (its stopwatch reading), sent back unchanged so the client can measure the round trip. |

Server to client:

| Message | Meaning |
| --- | --- |
| `{"t":"welcome","id":"..","name":"..","avatar":"..","room":"..","peers":[{"id","name","avatar","lat","lon","alt","yaw"}],"history":[...],"signedIn":true,"personId":"..","home":{"lat","lon","name"},"now":1700000000000}` | You are in. `name` may differ from what you asked for if it was taken. `history` holds recent chat lines. A peer who is riding has `"ride":{"thing","sp","seat"}`, and `left` lists what is standing where a rider left it. `personId` and `home` (which may be `null`) are present only for a signed-in player; a signed-in client should start at `home` when it is set. |
| `{"t":"time","c":1234.5,"now":1700000000000}` | The answer to `time`: the server's clock in milliseconds since 1970. Shared time is `now` plus half the round trip; a client keeps the answer with the shortest round trip and asks again now and then. `welcome` carries `now` too, as a first estimate. Clients that ignore both still work; they just have no animals in step with everyone else. |
| `{"t":"ride","id":"..","thing":918398760,"sp":"horse","seat":0}` / `{"t":"ride","id":".."}` | Someone hopped on something, or off. Sent to the whole room, the rider included: for the rider it is the go-ahead. |
| `{"t":"left","thing":918398760,"sp":"horse","lat":..,"lon":..,"alt":..,"yaw":..,"until":1700000060000}` | A driver got off: the thing stands there until `until` (server clock, ms), then goes back to where it belongs. |
| `{"t":"join","id":"..","name":"..","avatar":".."}` / `{"t":"leave","id":".."}` | Someone arrived or left. |
| `{"t":"peers","p":[[id,lat,lon,alt,yaw],...]}` | People who moved since the last update (10 per second). |
| `{"t":"chat","id":"..","name":"..","text":"..","ts":1700000000000}` | A chat line (also echoed to the sender). |
| `{"t":"people","p":[{"id","name","avatar","online","room","place","lat","lon","lastSeen","home"}]}` | Everyone with an account (guests are not listed), online first. Sent right after `welcome`, whenever someone with an account arrives or leaves or their place name changes, and on request. `room` and `place` are where they are, or were last; `lat`/`lon` (about 10 m precision) only while online; `lastSeen` is milliseconds since the epoch; `home` is the name of their home or `null`. Place names come from a reverse lookup of the position, rounded to about a kilometre and at most once every 30 s per person. |
| `{"t":"home","lat":..,"lon":..,"name":".."}` | Your home was saved. |
| `{"t":"error","code":"denied" \| "full" \| "slow" \| "guest" \| "nowhere" \| "home" \| "taken","text":".."}` | Something was refused. |

### Riding

A ridden thing belongs to its rider: the rider's client moves it (it goes where they go), and everyone
else draws it under the rider, from the positions players already share. The server keeps only who is
on what. It never knows where a horse is.

- A `thing` is the identity clients already use: an animal's (`hash32(home id, k + 1)`, the `id` of
  `creatureAt`), a tractor's or boat's the same way, a `car` or `route` item's `id`, a `train` item's
  `id`. `sp` says what it is: `horse`, `cow`, `sheep`, `camel`, `llama`, `kangaroo`, `deer`, `tractor`,
  `boat`, `sailboat`, `car` or `train`. The server checks only that `sp` is one of these.
- The first rider of a thing gets seat 0 and steers. The next three get seats 1 to 3 as passengers; a
  fifth is refused with `taken`. A `train` takes any number, all with seat 1: it keeps to its timetable
  and carries them.
- Asking for something else, hopping off, or leaving the room takes a rider off what they were on.
  When the driver gets off, the passengers are taken off too (each gets a `ride` without `thing`), and
  a `left` goes out with the driver's last position. A train is never "left".
- While a thing has a driver, and while it stands where it was left (60 s), clients do not draw it
  where its timetable has it. A rider reports the seat's position in `pos`, so their figure sits on
  top; the browser draws the thing at ground level under seat 0 and puts passengers 0.7 m behind
  per seat. When `until` passes the thing is simply back where it belongs.
- Where a ridden thing may go is the rider's client's business: in the browser, boats keep to water
  and everything else keeps off it, at a pace of its own (horse 10 m/s, cow 4, sheep 4.5, camel 5.5,
  llama 5, kangaroo and deer 9, tractor 5, car 13, rowing boat 2.5, sailing boat 5; a little over half
  of that unless Shift is held).
