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
that are not garages, sheds or shops) get a door on the wall facing the nearest road, and so do
smaller blocks of flats.

What the paints are, how many houses are brick (23) and not painted (20), whether roofs are
pitched, flat behind a parapet (the parapet is wall, the roof inside it roof) or mansard, and how
tall an unmeasured building stands, all depend on where in the world the chunk is and on how
closely built the ground round the building is (`server/src/styles.ts`, and `crowding` in
`server/src/chunk.ts`). None of that changes the format: clients go on drawing ids in the colours
they are sent. A wall is always sent as four corners and two triangles, lower edge first, which a
client may rely on to fit windows to it (the browser does; gable ends are single triangles).

Streets and gardens: 14 pavements, laid beside roads where the ground is residential or paved
or buildings stand within about 40 m, a little lower than the road so that crossing roads cover
them; 15 road markings; 32 hedges and 33 fences round front gardens, whose paths are ordinary
path sections (11). Where gardens have low walls, those are woodwork (27) in the colour of the
house. None of these collide.

## Labels: `GET /v1/labels/16/{x}/{y}`

House numbers and street names for the same chunk, as JSON. The route is **optional**: a
client that ignores it still gets the complete world from the chunk meshes. It takes the
same access code, zoom and rate-limit rules as the chunk route, and the same `x`/`y`
numbering. Both clients plant their trees from it (and skip mesh section 30); the Unreal
client also spawns letterboxes and sign posts from it. Both clients bring the animals,
cars and trains to life from it (see "Life" below).

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
| `pig`, `goat`, `donkey`, `goose` | Farm animals like the first four: pigs and geese in farmyards, donkeys and goats in paddocks, goats on some meadows. |
| `mouse`, `hedgehog`, `snail` | Beside some homes that have no cat or dog (hedgehogs in the Old World only). |
| `butterfly`, `bee`, `grasshopper`, `ladybird`, `snail`, `ant` | Grass and farmland, and a few butterflies over unmapped ground; ants on paved ground too. None beyond latitude 66. Butterflies, bees and dragonflies never land: a client draws them 0.4 to 1.6 m up. |
| `frog`, `heron`, `beaver` | Open ground within 30 m of fresh water. |
| `swan`, `otter`, `dragonfly` | Fresh water within 60 m of the bank. |
| `crab`, `seagull` | Sand. |
| `tortoise`, `flamingo`, `seal` | Sand: tortoises within latitude 42, flamingos within 33, seals beyond 50 north or 40 south. |
| `sparrow` | Paved or built-up ground. |
| `fox` | Open ground within 60 m of a wood. In its place: `panda` in central China, `monkey` in the tropics, and now and then `moose` or `bear` in the north. |
| `koala` | Under some trees in eastern Australia. |
| `zebra`, `giraffe`, `elephant`, `lion` | Open ground in Africa south of latitude 16; elephants in south and south-east Asia too. |
| `bison`, `reindeer`, `marmot`, `capybara` | Open ground: bison on the American plains, reindeer beyond latitude 62, marmots above 1400 m in the north, capybaras by fresh water in South America. |

The kinds from `pig` down were added later and are placed at spots of their own, after everything
above, with a limit of their own (40 homes and 130 animals a chunk), so the first animals are where
they always were. Exactly which regions is `localFauna` in `server/src/life.ts`.
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

## Inside houses: `GET /v1/interior/16/{x}/{y}/{id}`

Most homes can be walked into. A plain four-cornered house gives the whole of itself to its rooms.
A house of any other outline, or one more than 24 m long, gives the largest rectangle that fits
inside it with one side along the wall its front door is on and the door in that side (`roomInside`
in `server/src/chunk.ts`), so the rooms are always within the real walls. A house keeps its door
shut only when no room 4 m a side fits behind it, or when the ground drops more than 6 m across it.

The labels of a chunk list the doors that open as items of kind `door`: `u`, `v` are the door on the
wall, `h` the height of the floor inside, `g` the height of the ground outside the door, `yaw` the
compass heading out of the door, `id` the building, and `porch` is 1 where a porch roof covers the
door (it reaches 1 m out and its top is 2.76 m above `g`). The floor is level with the highest
ground at the house's walls, so on a hillside `h` can be several metres above `g`: a client lets a
player in by putting them about a metre inside the door at height `h`, and out by putting them a
little beyond it on the ground; the walls are in the way otherwise. Anything hung over the door
outside, such as a sign saying that it opens, goes by `g`, not `h`.

This route gives the inside of home `id` of chunk `x`, `y`: 404 when the chunk has no such home. The
answer is in the chunk format above, placed in the same chunk coordinates, so it sits inside the
house's real walls and players inside are where their positions say they are. Its surfaces have ids
of their own:

| Id | Surface | Collides |
| --- | --- | --- |
| 40 | floors, one colour a room | yes |
| 41 | walls: the lining of the outside walls in each room's paint, and the walls between rooms with their doorways | yes |
| 42 | the ceiling, facing down: 2.6 m up, or as little as 2.3 m where the walls of a hillside house end sooner | no |
| 43 | furniture | yes |
| 44 | windows, their frames, and the front door seen from inside | no |
| 45 | rugs and mats | no |

Walls and ceilings are single sheets, so draw these surfaces from both sides. The rooms come from
thirty layouts (`LAYOUTS` in `server/src/interior.ts`) stretched to the house; which layout, the
paints and the furniture all follow from the building's identity, so a house is the same inside
for everyone. Only the ground floor is built.

## Place search: `GET /v1/geocode?q=...`

`200 {"name": "...", "lat": 48.85, "lon": 2.29}` or `404`. `q` may also be `"lat, lon"`.

## Where am I: `GET /v1/place?lat=...&lon=...`

`200 {"name": "Montmartre, Paris", "country": "France"}`, either of which may be `null`. For the header
that tells a player where they are. The position is rounded to two decimal places (about a kilometre)
before it is looked up, and answers are remembered, so a client may ask again whenever its own rounded
position changes. It takes the same access code as the other routes.

## My journal: `GET /v1/journal`

The journal (see "Journal" under Meetups) of whoever the request's player token belongs to, whether or
not they are in the world. 401 without a token. There is no way to ask for another person's.

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
| `{"t":"hello","name":"Mum","room":"family","avatar":"owl","token":"..."}` | Must be first. `avatar` is the player's animal: a short lowercase id (`fox`, `bear`, `rabbit`, `cat`, `owl`, `frog`; anything invalid becomes `fox`). Clients decide how each animal looks. `token` is the access code or a player token (or comes from the browser cookie). A signed-in client may leave out `name` and `avatar` to use the account's; when it sends them, they become the account's. Optional `tz` is how many minutes the player's clock is ahead of UTC (780 in Auckland in summer): their day's tasks turn over at their own midnight. Left out, the day is UTC's. |
| `{"t":"pos","lat":..,"lon":..,"alt":..,"yaw":..}` | Where I am (feet, metres above sea level; yaw is a compass heading in degrees). Send about 10 times a second. |
| `{"t":"chat","text":"hello"}` | Say something to the room. |
| `{"t":"home"}` / `{"t":"home","lat":..,"lon":..,"name":"Eiffel Tower"}` | Signed-in only. Make where I stand my home (the server names the place), or the given place. Answered with a `home` message, or `error` `guest` / `nowhere`. |
| `{"t":"people"}` | Ask for the people list again (it is also pushed whenever it changes). |
| `{"t":"ride","thing":918398760,"sp":"horse"}` / `{"t":"ride"}` | Hop on something, or (with no `thing`) hop off. See "Riding". |
| `{"t":"talk","thing":918398760,"sp":"cow"}` / `{"t":"talk","thing":..,"sp":"cow","text":"what do you eat?"}` | Say hello to a thing, or say something to it. See "Talking". |
| `{"t":"taxi","place":"the beach"}` | Call a taxi to take me somewhere. See "Taxis". |
| `{"t":"journal"}` | Ask for my own journal. See "Journal". |
| `{"t":"pet","sp":"cow"}` / `{"t":"pet"}` | Choose the companion that follows me, from those I have won, or send it home. See "Riddles and companions". |
| `{"t":"expedition","start":"hunt"}` / `{"t":"expedition","drop":"hunt"}` | Set out on the treasure hunt of where I stand (`hunt`) or on an expedition by its id (`farm`, `capitals`, `penguin`...), or give one up. The answer is my `journal`. See "Treasure hunts and expeditions". |
| `{"t":"garage","call":true}` / `{"t":"garage","away":true}` / `{"t":"garage","paint":"blue"}` / `{"t":"garage","body":"van"}` | My own car: bring it to where I stand, send it away, or choose (and if need be buy) its paint or body. See "The garage". |
| `{"t":"favour","drop":"cow:918398760"}` | Give up a favour I was asked. The answer is my `journal` without it. See "Favours". |
| `{"t":"hat","buy":"cap"}` / `{"t":"hat","wear":"cap"}` / `{"t":"hat"}` | Buy a hat with my coins and put it on, put on one I own, or take my hat off. See "Daily tasks, coins and hats". |
| `{"t":"talk",..,"lat":..,"lon":..}` | `talk` may say where the client sees the thing, in case it is asked to do something from there. See "Doing as asked". |
| `{"t":"time","c":1234.5}` | Ask the time. `c` is any number of the client's own (its stopwatch reading), sent back unchanged so the client can measure the round trip. |

Server to client:

| Message | Meaning |
| --- | --- |
| `{"t":"welcome","id":"..","name":"..","avatar":"..","room":"..","peers":[{"id","name","avatar","lat","lon","alt","yaw"}],"history":[...],"signedIn":true,"personId":"..","home":{"lat","lon","name"},"now":1700000000000}` | You are in. `name` may differ from what you asked for if it was taken. `history` holds recent chat lines. A peer who is riding has `"ride":{"thing","sp","seat"}`, and `left` lists what is standing where a rider left it. `personId` and `home` (which may be `null`) are present only for a signed-in player; a signed-in client should start at `home` when it is set. |
| `{"t":"time","c":1234.5,"now":1700000000000}` | The answer to `time`: the server's clock in milliseconds since 1970. Shared time is `now` plus half the round trip; a client keeps the answer with the shortest round trip and asks again now and then. `welcome` carries `now` too, as a first estimate. Clients that ignore both still work; they just have no animals in step with everyone else. |
| `{"t":"ride","id":"..","thing":918398760,"sp":"horse","seat":0}` / `{"t":"ride","id":".."}` | Someone hopped on something, or off. Sent to the whole room, the rider included: for the rider it is the go-ahead. |
| `{"t":"left","thing":918398760,"sp":"horse","lat":..,"lon":..,"alt":..,"yaw":..,"until":1700000060000}` | A driver got off: the thing stands there until `until` (server clock, ms), then goes back to where it belongs. |
| `{"t":"order","thing":918398760,"sp":"dog","act":"follow","by":"..","lat":..,"lon":..,"at":..,"until":..}` | A thing was told to do something and agreed. See "Doing as asked". |
| `{"t":"taxi","thing":..,"by":"..","name":"Hackney","path":[[lat,lon],..],"at":..,"until":..,"dest":"Goat Island Beach, Leigh"}` / `{"t":"taxi","thing":..,"gone":true}` | A taxi is on its way to whoever called it, or one nobody boarded has driven off. See "Taxis". |
| `{"t":"pet","id":"..","sp":"cow","thing":3049913570}` / `{"t":"pet","id":".."}` | A member's companion has come along, or gone home. Sent to the room; `welcome` gives each peer's as `pet: { sp, thing }`. |
| `{"t":"car","id":"..","thing":322932241,"body":"car","paint":15239605,"lat":..,"lon":..,"yaw":0}` / `{"t":"car","id":".."}` | A member's own car stands here, with this body and paint (a colour as a number); or has gone. Sent to the room; `welcome` lists them as `cars`. |
| `{"t":"hat","id":"..","hat":"cap"}` / `{"t":"hat","id":".."}` | A member has put a hat on, or taken it off. Sent to the room; `welcome` gives each peer's as `hat: "cap"`. |
| `{"t":"journal","journal":{..}}` | The answer to `journal`: the asker's own journal, or `null` on a server that keeps none. |
| `{"t":"stamp","kind":"stamp","title":"Countries: 3","text":"You have visited 3 countries"}` | The player earned something, just now. `kind` is `stamp`, `country` (a country new to them; `title` is its name) or `level`. Sent to that player alone. |
| `{"t":"say","thing":918398760,"sp":"cow","name":"Daisy","text":"Grass, mostly.","by":"..","q":"what do you eat?","lat":..,"lon":..}` | A thing spoke. Sent to whoever talked to it (`by`) and to everyone within 80 m of them. `q` is what it was asked (absent for a hello); `lat`/`lon` are where the asker stands, for clients that cannot see the thing itself. |
| `{"t":"join","id":"..","name":"..","avatar":".."}` / `{"t":"leave","id":".."}` | Someone arrived or left. |
| `{"t":"peers","p":[[id,lat,lon,alt,yaw],...]}` | People who moved since the last update (10 per second). |
| `{"t":"chat","id":"..","name":"..","text":"..","ts":1700000000000}` | A chat line (also echoed to the sender). |
| `{"t":"people","p":[{"id","name","avatar","online","room","place","lat","lon","lastSeen","home"}]}` | Everyone with an account (guests are not listed), online first. Sent right after `welcome`, whenever someone with an account arrives or leaves or their place name changes, and on request. `room` and `place` are where they are, or were last; `lat`/`lon` (about 10 m precision) only while online; `lastSeen` is milliseconds since the epoch; `home` is the name of their home or `null`. Place names come from a reverse lookup of the position, rounded to about a kilometre and at most once every 30 s per person. |
| `{"t":"home","lat":..,"lon":..,"name":".."}` | Your home was saved. |
| `{"t":"error","code":"denied" \| "full" \| "slow" \| "guest" \| "nowhere" \| "home" \| "taken","text":".."}` | Something was refused. |

### Talking

Everything can be talked to. A `thing` is the same identity as for riding, with two more kinds that
stand still: a `tree` and a `house` (a `house` label item) take
`hash32(hash32(round(x × 8192), round(y × 8192)), salt)`, where `x`, `y` are the item's chunk number plus
its `u`, `v`, and `salt` is `0x54524545` for a tree and `0x484f5553` for a house (0 becomes 1). `sp` is
any animal of "Life", or `tractor`, `boat`, `sailboat`, `car`, `train`, `tree`, `house`.

The server decides who each thing is, from `thing` and `sp` alone (`persona` in `server/src/talk.ts`):
a name, one of fifteen characters (cheerful, grouchy, dreamy, boastful, shy, nosy, forgetful, dramatic,
philosopher, campaigner, eccentric, joker, worrier, poet, sporty), and a quirk. So the same thing is
the same somebody for everyone, on every visit. Clients learn a thing's `name` when it first speaks.

- `talk` without `text` is a hello: the thing introduces itself from its own stock of lines. Free.
- `talk` with `text` (200 characters at most) gets an answer. With `ANTHROPIC_API_KEY` set on the
  server the answer comes from Claude, in character; without it, or once the day's spending allowance
  is used up, or if the service fails or declines, the thing answers from its stock lines instead.
  Clients cannot tell the difference and need not.
- At most 12 `talk` messages a minute per player, and not two within 1.2 s (`error` code `slow`).
- What goes to the AI service: the character's description, the area's name (about a kilometre across),
  the last six exchanges with that thing in that room (kept ten minutes, in memory only), and what
  was typed, attributed to the player's animal ("A fox says: ..."), never to their name.

The key is T in both games; while talking to a thing, what is typed goes to it instead of to the room.

### Doing as asked

What a player says to a thing can be an instruction, and the thing does it as well as answering. The
server decides what was asked (with the AI through a tool it may call, and without it from plain
words: "follow me", "come here", "stay", "go home", "do a trick", "moo", "take me to the beach")
and whether this kind of thing can do it (`deedsOf` in `server/src/talk.ts`): the animals that walk
can follow, come, stay, go home, do a trick and make their noise; those that can be ridden, and cars
and tractors, can also take their rider somewhere; cars and tractors can stop, go home and toot; a
train can whistle; trees, houses and boats only talk. The answer in words comes as `say`, as always.
What is to be done comes as `order`:

| `act` | Sent to | Meaning |
| --- | --- | --- |
| `follow` | the room | The thing walks behind member `by` until `until` (ten minutes), or until told otherwise. `lat`/`lon` are where it was when told, by the word of the player who told it (their `talk` message; their own position failing that). |
| `come` | the room | It walks from `lat`/`lon` to `to` (`[lat, lon]`, where the asker stood) and waits there. |
| `stay` | the room | It waits at `lat`/`lon`. |
| `home` | the room | It goes back to its timetable: forget any order for it. Also sent when whoever gave the order leaves, when someone hops on the thing, and when one player has more than six things under orders (the oldest goes home). |
| `trick`, `noise` | the room | Done once, now, wherever each client has the thing: a jump and a spin with its noise, or the noise alone. Not remembered. |
| `goto` | the asker alone | Only for a thing the asker is riding (seat 0). `name`, `lat`, `lon` are the place, found near the rider first and then anywhere; `path`, when present, is the way there by road as `[lat, lon]` points about 8 m apart (cars and tractors, places within 2.5 km). The rider's own client carries them: along `path`, or straight across country on an animal when the place is within 1.5 km, or in one jump (hop off, travel, hop on again). Friends see it through `ride` and the positions already shared. |

`welcome` carries `orders`: the `follow`, `come` and `stay` orders still in force. Clients draw a thing
under orders where the order puts it and not where its timetable would (as they do a ridden thing).
Two clients work a follower out separately from the same order and the same player positions, so they
agree to within a step or two, not to the millimetre.

### Taxis

`taxi` with a `place` calls one. The server finds the place (near the caller first), a road for the
taxi to arrive by from a few streets off, and the way from the caller to the place when it is close
enough to drive; then it tells the room. A taxi is a thing like any other, of kind `taxi`, with an
identity made for the occasion and a name: it can be ridden (four seats), talked to, and told to go
somewhere else.

- `path` is the road it comes along, ending beside where the caller stood. It set off at `at`
  (server clock) and goes at 9 m/s, so every client draws it in the same place: along `path` by the
  shared clock, then waiting at the end until `until` (five minutes after the call).
- When someone hops on (`ride` with `sp` `taxi`; refused with `taken` for a taxi that is not
  waiting), whoever takes seat 0 is the fare: after the `ride` message they are sent an `order` with
  `act` `goto` for the place asked for, and their client carries them there as for any "take me to"
  ("Doing as asked"). Friends who hop on too ride along.
- While the fare is aboard the taxi says something of its own about every half minute, ten times at
  most: a `say` with no `q`, heard like any other. With the AI these come from the same character
  that answers when it is talked to; without it, from a stock of remarks.
- When the fare gets out the ride is over: the taxi stands where it stopped for a minute, like
  anything a rider has left, and is then gone. A taxi nobody boards, or whose caller leaves or calls
  another, goes with `gone`.

`welcome` carries `taxis`: those still waiting. One call every 15 seconds a player.

### The garage

Every player has a car of their own (`server/src/garage.ts`). `garage` with `call` brings it to
stand three metres to their right; the room is told with `car`, and clients draw a car of that
`body` (`car` or `van`, both already in the clients' figure tables) in that `paint` at that place,
under the identity `thing`. It is ridden like any car (`ride` with `sp` `car` and that `thing`), but
only its owner may take the wheel: anyone else is refused with `error` code `taken` unless the owner
is driving, when they get a passenger's seat. When its owner gets out it stays where it is, told
again with `car` (not `left`), until they call it elsewhere, send it `away`, or leave the room.

`garage` with `paint` or `body` chooses one, paying for it in coins the first time (`error` code
`poor` without them); four paints and the car body are free. The answer is the `journal`, whose
`garage` is `{ body, paint, paints: [{ id, name, hex, price, owned }], bodies: [{ id, name, price,
owned }] }`. A car that is standing in the room is repainted at once.

How a car drives is each client's own affair (the browser's `cardrive.js`); the server passes on
its driver's positions as for anything ridden.

### Treasure hunts and expeditions

Both are begun from the passport with `expedition`, and both are noticed done by the server from
the `pos` and `talk` messages it already gets.

A treasure hunt (`server/src/hunt.ts`) is up to five clues, each a riddle about a real kind of place
the map knows near where the hunt begins: a place of worship, a school, a barn, a shop, water, a
wood, a stream, the railway, a street by its name, a house by its number. It is made from the map
for a square about a kilometre across and a day, so everyone who starts one in the same
neighbourhood on the same day gets the same hunt. A clue is found by standing within its reach (25
to 70 m); the clients are never told where the places are, only, in the journal, which way and
roughly how far the next one lies. News comes as `stamp` messages of kind `hunt`; the last, "Treasure
found!", carries `at: { lat, lon }`, where the finder stood, for their game to show a chest. Where the
map knows too little, `expedition` is refused with `error` code `locked`.

An expedition (`EXPEDITIONS` in `server/src/expeditions.ts`) is one of three sorts: an `album` (talk
to enough of a family of things), a `tour` (stand within reach of enough of a list of famous
places) or `home` (a lost animal walks with the player, as their `pet`, until they stand in the part
of the world it comes from; that kind of animal is then theirs as a companion). Only what is done
after setting out counts. Three may be under way at once, and one lost animal. News comes as `stamp`
messages of kind `expedition`.

In the journal object: `hunt` is `{ at, of, clue, way, minutes }` or null (`way` is "about 250 metres
to the north-east" from where the player stands), `huntsDone` and `huntBestMinutes`; `expeditions` is
`[{ id, sort, title, blurb, coins, state, have, need, items: [{ name, got }] }]` with `state` one of
`open`, `active`, `done`; `passenger` is the lost animal travelling with the player, or null.

### Favours

The things a player talks to may ask a favour, each to do with what the thing is
(`server/src/favours.ts`). There are five kinds: `ride` (ride or drive the thing so many metres),
`walk` (have it follow you so many metres on foot), `greet` (say hello for it to a thing of some
kind), `carry` (take a parcel or a seed to another house or tree at least so far away) and `look`
(go so far from a thing that cannot move, then come back and talk to it). Which one a thing asks,
and how far, comes from its identity and the day, so everyone is asked the same.

A thing asks when the player offers help in a `talk` ("can I help?", "any jobs?"), and about one
thing in three asks of its own accord when greeted. The asking is part of the thing's `say`: in
plain words, or in its own when an AI is speaking for it. A player has at most three favours open,
and each thing asks one a day. The server notices a favour done from the `talk`, `ride`, `order`
and `pos` messages it already gets; clients send nothing extra.

News comes as `stamp` messages of kind `favour`: "A favour for Daisy" when asked, "Far enough"
half-way through a `look`, "Favour done" with the coins it paid. A favour finished on the move is
followed by a `say` from the thing, with its thanks. Nothing can be failed: a favour waits until it
is done, dropped with `favour`, or a few days old.

In the journal object: `favours` is `[{ id, name, sp, text, coins, have, goal, unit, next }]` (`id`
is the giver's kind and identity, `next` a line saying what to do now) and `favoursDone` a count.

### Daily tasks, coins and hats

Every day has three small tasks (`TASKS` in `server/src/daily.ts`): somebody to talk to, somewhere
to go, something to try. They are the same three for everyone whose day it is; a day is a calendar
day on the player's own clock (`tz` in `hello`). The server notices a task done from the `pos`,
`talk` and `ride` messages it already gets; clients send nothing extra and cannot finish one by
saying so. Nothing can be failed: at midnight three new tasks take the place of the old.

A task done pays 10 coins, all three pay 20 more and count as a full day, and a solved riddle pays
15. Each is told to the player with a `stamp` of kind `task` (also sent on joining, to say what
today's tasks are), and a hat won with one of kind `prize`.

Coins buy hats (`HATS`): `hat` with `buy` pays for one and puts it on (refused with `error` code
`poor` without the coins, `locked` for a hat that can only be won); `hat` with `wear` puts on one
already owned (`locked` otherwise); `hat` with neither takes it off. Two hats are prizes, for one
and for seven full days. The room is told with `hat`; clients draw the hat on that player's figure
from its id (`server/public/js/hats.js`) and skip ids they do not know.

In the journal object: `coins` is the coins in hand; `today` is `{ tasks: [{ id, text, have, goal,
unit, done }], all, coinsEach, coinsAll, fullDays }`; `hats` is `[{ id, name, price, how, owned }]`
(`price` null and `how` set for a prize); `hat` is the one worn or null.

### Riddles and companions

The journal carries riddles (`RIDDLES` in `server/src/journal.ts`). Each is unlocked at a level and
solved by finding its answer in the world after that: talking to a thing of the right kind, riding
one, or (for one of them) having set foot on three continents. The server notices from the `talk`
and `ride` messages it already gets; clients send nothing extra. A solved riddle is announced with
a `stamp` of kind `riddle`, as are new riddles when a level brings them.

Solving a riddle wins its answer, or an animal that goes with it, as a companion. `pet` with an `sp`
chooses one of those won (refused with `error` code `locked` otherwise); `pet` with none sends it
home. The choice is kept in the journal, so the companion comes along on the next visit too. The
room is told with `pet`: `thing` is the companion's identity, made from its player's own, so it is
the same somebody every time and can be talked to (and ridden, if its kind can be). Clients draw it
following a couple of metres behind its player, each working that out for itself from the positions
already shared, as for a thing told to follow.

In the journal object: `riddles` is `[{ id, text, solved, answer }]` for those unlocked (`answer` is
null until solved), `moreRiddles` is `{ count, level }` for the next batch or null, `pets` the
companions won, and `pet` the one chosen or null.

### Journal

The server keeps a journal for every player from what it already sees: positions, `ride` and `talk`.
Clients send nothing extra. A signed-in person's journal is kept on the server's disk and carries on
from visit to visit; a guest's lasts for the visit. A journal is its owner's alone: it is sent only in
answer to `journal` on that player's own connection, or from `GET /v1/journal` with that person's
token, and no request can name somebody else.

The journal object:

| Field | Meaning |
| --- | --- |
| `kept` | `true` when it is stored (signed in), `false` for a guest |
| `since` | when it was started, milliseconds since 1970 |
| `level` | `{ n, title, points, from, next }`: the level, its name, the points so far, and the points at which this level began and the next begins |
| `totals` | `{ km, kmRidden, minutes, visits, countries, continents, places, friends }` |
| `countries` | `[{ name, first }]` in the order first visited |
| `continents` | names |
| `places` | the twelve most recent, `[{ name, country, last, times }]`; a place is about a kilometre across |
| `friends` | the twelve most recent things talked to, `[{ name, sp, times, last }]` |
| `talkedKinds`, `riddenKinds` | the kinds (`sp`) of thing talked to and ridden |
| `stamps` | `[{ id, title, have, steps, done, next, unit }]`: something counted (`have`), the numbers at which it is stamped (`steps`), how many of those are reached (`done`) and the next one (`next`, or `null`) |

How it is counted: distance is added whenever a player has moved 15 m, as ridden while they are on
something and as walked otherwise; a step of more than 400 m is a journey by `/goto` and adds none.
A place is the position rounded to two decimals, named by the same lookup as `GET /v1/place`, at
most one lookup every four seconds a player. Continents come from rough boxes (`continentOf` in
`server/src/journal.ts`).

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
