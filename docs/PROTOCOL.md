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
as `token`. Without it they answer `401`. `GET /health` is always open (it also says how many megabytes of memory the server holds, `mem`, and the most since it started, `memMost`) and reports
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
| materialId | u32 | 0–8 ground types, 9 ground cut round a tunnel's mouth, 10–15 roads/paths/rail/streams/pavements/markings, 16–19 bridges and tunnels, 20–29 buildings, 30 trees, 32–33 hedges and fences |
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
collision); 29 walls with no windows (masts, spires, drums and other pieces of buildings mapped
in 3D). A client that does not know an id can draw it in its colour. Homes (small buildings
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

### Bridges and tunnels

A road, path or railway on a bridge is not drawn on the ground. It is drawn at a height the server
works out (`server/src/spans.ts`; the map hardly ever says how high a bridge is): straight from the
ground at one end to the ground at the other, a little arched (much more over the sea), and lifted
to clear whatever road, railway, path or river passes under it. Where that leaves an end of it in
the air, the roads that meet it there climb to it on a ramp, at most 70 m long.

| Id | What it is | Collides |
| --- | --- | --- |
| 16 | A way that is not on the ground: the top of a bridge's deck, the top of a ramp up to one. Its colour is that of what it carries (road grey, a railway's brown, a path's gravel, boards). Players, cars and trains stand on it **at its own height**, whatever the ground is under it. | yes |
| 17 | What holds a bridge up and in: the sides and underside of the deck, solid side walls about 1 m high, piers, the walls of a ramp. | yes |
| 18 | Railings and cables: thin things with the sky between them. A footbridge's rails (a deep handrail and a lower rail, on posts), the hangers of a great arch. | yes |

Nothing about the ground changes for a bridge: the terrain sections (0–8) under it are whole, and a
road that passes under it is an ordinary road section. So a client has to keep two levels apart at
such a place. What is asked of it:

- **Standing.** The floor under a player (or a car, a train, an animal) is the highest of the terrain
  and the surfaces 16 that is not above their feet by more than a step (about 1.2 m). On a bridge that
  is the deck; under it, the road. The browser does this with a ray cast straight down from head
  height against the colliding sections.
- **Not falling off, not walking through.** Sections 17 and 18 stop a player sideways as walls do.
  A deck's side walls are waist high; its underside is well over head height wherever something
  passes under it (5.2 m over a road, 6 m over a railway, 3 m over a path).
- **Water.** A car on a bridge is over water, not in it: "is this water?" has to be asked of the
  floor the car is on, not of the terrain below.

A bridge is drawn into every chunk it passes through, and overlaps the chunk's edges a little, as
roads do. Piers belong to the chunk they stand in.

Three kinds of bridge are built, and all three are only sections 16 to 18 in other shapes and
colours, so a client that draws those draws them all: a footbridge or boardwalk, with rails (18) in
place of solid walls; in Europe and round the Mediterranean, a road bridge over water, in stone, on
arches from pier to pier; and everything else, a deck on concrete piers. A bridge whose run from
ground to ground is 400 m or more, with 250 m of it over the sea, also gets a great steel arch over
its middle (two ribs in 17, hangers in 18, a stone tower at each foot). Carriageways that the map
draws side by side share one arch.

**Tunnels.** A road, a railway, or a path that is not the corridor of a station, when the map puts it
in a tunnel, is a tube under the ground. Its floor starts at the ground at each mouth and runs
straight between them, diving under the ground (no steeper than one in ten for a road, 7 in 100 for a
railway, 12 in 100 for a path) wherever the ground is not already far enough above it: 7.2 m for a road, more for each
level further down the map puts it. Streams in pipes, ways through buildings and underground paths
with no way in from the street are still left out.

| Id | What it is | Collides |
| --- | --- | --- |
| 16 | The floor of the tunnel, as on a bridge: stood and driven on at its own height, which here is under the ground. | yes |
| 19 | The inside of the tunnel: walls and ceiling (5 m above the floor for a road, 5.6 for a railway, 3.1 for a path), the stone frame round each mouth and its wing walls, the wall across the end where the map stops a tunnel underground. | yes |
| 15 | The lamps: pale boxes under the ceiling every 16 m, in a colour of their own. (15 is otherwise road markings.) | no |
| 9 | Ground that is not on the terrain's grid: see below. Drawn and stood on like any ground, in the colour it is sent in. | yes |

Where a tunnel comes up through the ground (at a mouth, and wherever it is not deep enough to be
covered), **the terrain has holes**. The cells of the terrain's grid that the tunnel passes through
there are not drawn as terrain. Each is drawn again in section 9, in the same colour, as 6 by 6
smaller squares, less those in the tunnel's way. Where the ground does not cover the tunnel, earth is
banked over it, also in section 9. "In the tunnel's way" reaches a few metres out in front of a
mouth, so a piece of ground is laid there too (section 9, in the colour of the way, just under its
paint): with it there is something solid to stand on at every step into a tunnel, for a client that
stands on the triangles and not on the grid of heights. No tree is planted (in the mesh or in the
labels) in a tunnel's way within 85 m of its ends, where the tunnel is not yet under the ground.
Three things follow for a client:

- **The grid of heights is still whole.** Every vertex of the 65 by 65 grid is still sent in a
  terrain section (0 to 8), even where no triangle uses it, so a client that rebuilds the grid from
  those sections' vertices (as the browser does) gets a height everywhere. Section 9's vertices are
  not on the grid and must not be read into it: read only ids 0 to 8.
- **A cell with no terrain triangles has no terrain.** There the floor is whatever colliding surface
  (9 or 16) is under the player, and the grid's height does not count. The browser marks those cells
  when a chunk arrives (a cell none of whose terrain triangles is sent).
- **Under the ground, the ground overhead is not the floor.** The rule for standing is the same as on
  a bridge: the highest floor that is not more than a step above the feet. In a tunnel the terrain is
  metres overhead, so it is not that floor, and the tunnel's floor (16) is. A camera that keeps itself
  above the terrain must not do so while its player is under it.

A client that takes collision from the meshes (as an engine's physics does) gets all of this by
building collision for sections 9 and 16 to 19 as it does for buildings, and for the terrain as it
is sent, holes and all. What needs care is anything that asks "how high is the ground here?" by
looking straight down from the sky: over a bridge that finds the deck, and over a tunnel the hill.

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
| `kind` | `house` (a letterbox plate), `street` (a sign post), `tree`, or `home` (where a herd or flock lives), `car` (a parked car), `route` (a trip a car makes) or `train`; `door` (a front door that opens: "Inside houses"), `entry` (a door of a shop, an office, a mall...: "Inside other buildings") and `sign` (a name board). A client skips kinds it does not know. |
| `w`, `left`, `da`, `db`, `pts`, `lift` | Routes; see "Traffic". Trains have `da`, `db`, `pts` and `lift` too; see "Trains". Cars, routes and trains also carry an `id`. At most 60 cars and 14 routes per chunk. |
| `sp`, `n`, `r`, `id` | Homes only: the animal (one of those listed under "Life"), how many, the radius in metres of the circle they roam in (for `bird`, of the ring the flock flies), and the home's identity (a whole number from 1 to 4294967295, the same on every visit). Per chunk, at most 40 farm homes with 150 animals, 40 other homes with 120 animals, and one flock. A client skips animals it does not know. |
| `text`, `text2` | The plate text (absent on trees and homes). A `street` item at a crossing has two plates, `text2` being the second street; a street with no crossing nearby has only `text`. |
| `s`, `r`, `c` | Trees only: height and canopy radius in metres, and `c` = 1 for a conifer. Trees are the same ones the chunk mesh draws as cones (surface id 30), so a client with its own tree models skips that section and plants these instead. At most 1500 per chunk, thinned evenly. |
| `u`, `v` | Position across the chunk, as in the meshes: `u` 0 = west edge, 1 = east edge; `v` 0 = north edge, 1 = south edge. May fall slightly outside 0–1 for buildings that straddle the chunk edge. |
| `h` | Terrain-mesh height at the point, in metres above sea level, so the prop stands on the ground. |
| `yaw`, `yaw2` | Compass heading in degrees (0 north, 90 east) that the text of `text` / `text2` faces. |

**Name signs.** A `sign` item is what a building is called (its own name on the map, or that of the
one café, shop or museum mapped as a point inside it), to be drawn on a board on its front wall:
`{"kind": "sign", "text": "Ferry Building", "u": 0.41, "v": 0.52, "h": 14.2, "yaw": 180, "w": 5.1}`.
`u`, `v` and `h` are the middle of the board (`h` in metres above the sea, already clear of the wall),
`yaw` the way it faces and `w` how wide it may be, in metres; ours are 0.56 m tall, cream with dark
lettering that shrinks to fit. At most 20 a chunk (shops, churches, schools and buildings mapped in 3D first), and names are cut to 30 letters. A shop or a café
with a sign also has an awning and a shop window in the mesh, under where the board goes.

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
| `lift` | Only when the trip crosses a bridge or climbs a ramp to one: one number for each point of `pts`, the metres the road's surface is above the terrain there (0 on the ground). The car is drawn at the terrain's height plus this, moving evenly between points as it does along the road. Without it the whole trip is on the ground. |

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
animals' reactions. It then runs a little late and makes up the time.

### Cars and each other

A timetable knows nothing of the other cars, so left to their timetables cars drive through whatever is
in the way. Three things stop that. The first is the server's, the other two each client's own
(`trafficmotion.js` again, under "giving way"; the Windows game's `EarthLifeMotion.cpp` is the same line
for line, and `-EWLifeTest` holds the two against each other):

1. **Where cars stand.** The server ends a trip only at a stretch of kerb with nothing along it (no
   parked car and no other trip's end within 14 m on that side, nor on the other side where the car
   crosses over as it sets off for home), and starts one only from a space whose neighbours ahead are
   empty. A street under 6 m wide has parked cars along one kerb only.
2. **Steering round cars at the kerb.** A client tells each trip what stands beside its road (`setSpots`:
   the parked cars it draws, and where every trip's own car waits at its two ends). Beside one on its own
   side, the car moves over until there is 0.4 m between them, starting 10 m before it is level with it
   and back in its lane 10 m after; its body turns half as far as its path does. A spot counts only
   while something stands there (a trip's end while its car is away does not; a parked car somebody has
   driven off does not).
3. **Giving way.** Each frame every car looks along its own timetable, 4.2 s ahead, for where it would
   be inside another car's box (a little larger than the car) at the same moment, and 12.6 s ahead for a
   car coming the other way through a stretch with room for one. Of two that would meet, the one
   behind waits; of two that face each other, a car pulling out waits for one in its lane, and a car in
   its lane for one already out round a parked car; otherwise the one with the larger `id`. Waiting
   means its clock stops (it falls behind its timetable, at most 90 s) and it draws in to its kerb; free
   again, it makes the time up at 1.3 times its pace. A car out round a parked car goes on until it is
   back in its lane before it waits. Two that have stood for each other 8 to 14 s are let through each
   other, so nothing stands for ever.

What a client has worked out is its own: another client, which began watching at another moment, may
have a car a few metres from where this one has it while the car is waiting. Parked cars and the
timetables are the same for everybody.

## Trains

A railway runs far beyond the piece of map a chunk is built from, so the server takes the tracks
for a wider square (a zoom-14 tile, 4 by 4 chunks: `server/src/rail.ts`). That square is one block of
the map download, so the tracks come with the map the chunk is built from, and there are trains
whenever there is a world. Inside a square it
joins main-line tracks end to end, keeping straight on at points and cutting them at the square's
edge, and puts one train on each run of 400 m or more (the six longest at most). Sidings are left
out; tracks on bridges and in tunnels are part of the run like any other. Every chunk of the square builds its trains from the same tracks, and a `train` item is
sent with **every chunk its run passes through**, identical but for where its path is measured from.
A client keeps one of each `id`.

```json
{"kind": "train", "id": 1671733423, "u": -4.99986, "v": 0.5, "h": 61.2, "yaw": 0, "da": 23, "db": 31,
 "pts": [-4.99986, 0.5, 0, -4.97, 0.5, 6.67, -4.94, 0.5, 9.43]}
```

A train whose run crosses a bridge or goes through a tunnel also has `lift`: one number for each
point of `pts`, the metres the track is above the terrain there, or (in a tunnel, negative) below
it. Each carriage is drawn at the terrain's height where it is, plus the `lift` of that place on the
track. They are the same heights the chunks along the run are built with.

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

**Track with no train, and a train that carries on.** A square's other runs (the seventh longest and
after, and those shorter than 400 m, down to 30 m; forty at most) go out as `track` items: the same
shape as a `train`, with a timetable a train could keep along it, and no train. A game draws nothing
for one. They are there because a train's own run ends where its square does, about every two
kilometres, and somebody riding does not want to be taken back: when the train a player is on has
stood six seconds at an end of its run, and another run (`train` or `track`) has an end within 12 m
of that end and leads on much the same way (`joinOf`), the player's game carries the train on along
that run by a clock of its own (`runPose`), front first, and on again at the end of that, as far as
the line goes; where no run leads on it stands, and the player hops off. The game draws that train for
its player where it has got to, and leaves out the timetable's own train of the run it is on and the
one that was boarded. The server is told nothing new: the player's `ride` is still the train they
boarded, and their position says where they are. Friends on the same train go on together, since each
game works out the same moment; friends watching from the ground see the riders go on without a train
under them (not built). `server/public/js/trafficmotion.js` and `traffic.js` (`carryOn`,
`throughAt`); `EarthLifeMotion.cpp` and `AEarthLife::CarryOn` in the Windows game.

A railway on the ground is drawn as a bed of stones (surface 8), sleepers (12) and two rails (17):
surfaces the games have already.

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

This route gives the inside of building `id` of chunk `x`, `y` (a home's rooms, or what a shop, an
office or a mall has inside: next section): 404 when the chunk has no such building to walk into. The
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

## Inside other buildings: `entry` items and `GET /v1/inside/16/{x}/{y}/{id}`

Shops, cafés, offices, malls, blocks of flats, hotels, churches, schools, hospitals, factories,
warehouses and petrol stations open too, and can be walked through: each has its door on the street and, wherever one of its other walls is free, a second door on another side
(`server/src/venues.ts` chooses the buildings and the doors, `server/src/venue.ts` lays out the inside).

**Which buildings.** Not homes, not buildings mapped in 3D pieces, not sheds, garages or barns, and
nothing under 35 m2. Of the rest:

| `use` | The building | Its room, at most | Inside |
| --- | --- | --- | --- |
| `cafe` | somewhere to eat or drink | 14 by 12 m | a counter with a barista, tables and chairs, guests |
| `shop` | a shop, a supermarket, a bank | 16 by 16 m | a counter with a shopkeeper, shelves round the walls and in rows, shoppers |
| `mall` | a shop of 2500 m2 or more, one called a mall, an arcade or a market, one with three or more shops mapped inside it; and one in three of the big buildings the map says nothing about | 40 by 60 m | a walk from door to door with shops down both sides (the shops the map names inside it first, then made-up ones), benches, planters, a tree under a skylight |
| `office` | `building=office`, `commercial`, `government`, `civic` or `public`; and two in three of the big buildings (400 m2 or more, or 13 m or taller) the map says nothing about | 30 by 24 m | a front desk, desks in pairs, meeting rooms and a kitchen in the corners |
| `lobby` | `apartments`, `dormitory`, `residential`, `hotel`, or a building with a hotel mapped inside it | 12 by 10 m | an entrance hall: a lift, letterboxes and a caretaker (flats) or a desk, keys and luggage (a hotel), a sofa |
| `church` | a place of worship the map calls Christian, or gives no faith | 22 by 34 m, up to 5.5 m high | an aisle from the door to the far end, pews either side of it, a table with flowers and candles under a window of coloured glass, a stand to read from, the organ, the choir; tall windows of coloured glass down both sides, beams under the roof |
| `mosque` | a mosque | the same | a carpet with its rows marked, a tiled niche in the far wall with steps beside it, shelves for shoes by the door, books; nobody sits |
| `temple` | a place of worship of any other faith | the same | low benches either side of the aisle, a low table with flowers and lanterns under a hanging, a gong |
| `school` | a school or a kindergarten, and any `building=university` or `college` | 30 by 36 m | at 13 by 11 m or more a corridor straight back from the front door with rooms down both sides, each about 7.5 m long and up to 8 m deep, its name over its doorway: `CLASS 1`... (a blackboard, a teacher, desks for two), `LIBRARY`, `ART`, `MUSIC`; smaller, one classroom |
| `hospital` | a hospital or a clinic, at 13 by 11 m or more | 30 by 36 m | a hall across the front with a desk (`RECEPTION`) and rows of seats to wait on, then a corridor with rooms down both sides, up to 6 m deep: `WARD 1`... (beds with a curtain between, a cupboard by each), `DOCTOR` (a couch, a desk, a chart of letters), `X-RAY` |
| `clinic` | a hospital or a clinic smaller than that | one room | a desk, a row of seats, a couch with the doctor beside it, a cupboard under a chart of letters |
| `factory` | `building=industrial`, `factory` or `manufacture` | 30 by 40 m, up to 6 m high | a way through between yellow lines; a line down the hall (a machine with a funnel and a chimney at its head, then a belt with boxes on it) with makers along it, machines by the walls, crates, a fork-lift truck with somebody at the wheel; high windows and steel beams |
| `warehouse` | `building=warehouse` | the same | the same hall with rows of racking three shelves high in place of the line and the machines, and packers in the aisles |
| `fuel` | a petrol station's building (not its canopy, which is a roof and stays what it was) | 16 by 16 m | a shop like any other, with a counter and a shopkeeper; its shelves have cans of oil and things to eat |

No faith's own signs are drawn in any of the three halls: what they are is their furniture. The door of
a church at the far end is to one side, not behind the table; the back door of a school or a hospital with
a corridor is at the end of it, as a mall's is at the end of its walk.

As for a house, the room is the largest rectangle that fits inside the real walls behind the front door,
up to the size above; its floor is level with the highest ground under it, and it opens only if the
ground under it drops less than 6 m and the walls stand at least 2.3 m above the floor. A courtyard is
left out. At most 40 such buildings open in a chunk, those with a name first.

**The doors** are label items of kind `entry`, one for each door:

```json
{"kind": "entry", "id": 25412345, "use": "office", "text": "Harbour Works", "u": 0.41, "v": 0.52, "h": 14.2, "g": 13.9, "yaw": 180,
 "iu": 0.4102, "iv": 0.5231, "iyaw": 90}
```

`id` is the building (the same number on each of its doors; negative for a building mapped as a
relation), `use` what it is, `u`, `v` the door on the real wall, `g` the ground outside it, `h` the
floor inside, `yaw` the compass heading out of the door. `text`, on the first door of a building, is
its name. **`iu`, `iv`, `iyaw`** are there only when the door inside is not just behind the door
outside: they are that door on the wall of the room, and the heading out through it. (The room is a
rectangle and the building may not be, and a mall's back door is always at the end of its walk; so going
in at such a door moves a player a few metres.) A game lets a player in by putting them 0.9 m inside
the door inside (at `iu`, `iv` moved against `iyaw`; or `u`, `v` against `yaw`) at height `h`, facing in;
and out, when they are within reach of the door inside, by putting them 1.4 m outside the door outside on
the ground. Nothing is drawn on the outside wall by the server for these doors, except where `drawn` is 1
(the front door of a block of flats, which the mesh has always had): a game draws a door there itself
(ours: glass double doors 1.7 m wide and 2.2 m high in a white frame), and a board over every one of
them with `text`, or with what the place is.

A small shop, café, office, hotel, chapel, school or clinic that already opened as a house keeps its `door` item, which now
carries `use` (and `text`, its name) as well: it has that inside, not rooms, and nobody can make it
their home (a `house` claim on it is refused with the error `nohome`). Its second door is an `entry`.
(A petrol station's shop and a small workshop are among them: `use` `fuel` and `factory`.)

**The inside** comes from the same route as a house's, `GET /v1/interior/16/{x}/{y}/{id}`, in the same
format with the same six surfaces (40 to 45); a ceiling is 3 m up, or up to 4.2 m in a mall, 5.5 m in a
church and 6 m in a factory. It weighs 40 KB for a café to about 450 KB for the biggest mall (a house is 36 KB; a church at most
65 KB, a hospital 100 KB, a factory 145 KB, a school 170 KB).

**Who is inside**, what is written up in there and where food is sold come from
`GET /v1/inside/16/{x}/{y}/{id}` (same access rules; 404 for a house or a building that is shut):

```json
{"x": 33185, "y": 22545, "id": 25412345, "rev": 1, "use": "cafe", "name": "Kettle & Crumb", "size": 13.45,
 "people": [
   {"id": 2863311530, "sp": "rabbit", "role": "barista", "pose": "stand", "u": 0.4101, "v": 0.5212, "h": 14.2, "yaw": 90},
   {"id": 771239001, "sp": "bear", "role": "guest", "pose": "sit", "seat": 0.45, "u": 0.4105, "v": 0.5217, "h": 14.2, "yaw": 180},
   {"id": 99120034, "sp": "fox", "role": "shopper", "pose": "walk", "u": 0.4103, "v": 0.5214, "h": 14.2, "yaw": 0, "pts": [0.4103, 0.5214, 0.4103, 0.5221]}],
 "signs": [{"text": "MENU", "u": 0.41, "v": 0.5213, "h": 16.4, "yaw": 90, "w": 1.6}],
 "tills": [{"u": 0.4102, "v": 0.5212, "use": "food", "text": "Kettle & Crumb"}]}
```

| Field | Meaning |
| --- | --- |
| `size` | The room from corner to corner, in metres: a player is "in" the building while within that of one of its doors and within 6 m of its floor. |
| `use` | What the place is: `cafe`, `shop`, `mall`, `office`, `lobby`, `church`, `mosque`, `temple`, `school`, `hospital`, `clinic`, `factory`, `warehouse` or `fuel`, as on its doors. A game that does not know one calls it a building. |
| `people` | The animals inside: at most 20 in an office, 4 in a shop, 10 in a café, 25 in a mall, 4 in an entrance hall, 14 in a church, 30 in a school, 20 in a hospital, 16 in a factory. `sp` is one of the six animals a player can be (fox, bear, rabbit, cat, owl, frog), so a game draws them with the figure it already has. `id` is the same every visit: it is what a player talks to (below). `role`: `worker`, `meeting`, `reception`, `keeper`, `barista`, `shopper`, `guest`, `caretaker`, `resident`; `warden`, `musician`, `singer`, `visitor`; `teacher`, `pupil`; `doctor`, `nurse`, `patient`; `foreman`, `maker`, `packer`. |
| `pose` | `sit`: seated at `u`, `v`, facing `yaw`, on a seat `seat` metres above the floor `h`. `stand`: standing there, facing `yaw`. `walk`: strolling the path `pts` (`u`, `v` pairs) there and back for ever. |
| `signs` | Lettering to draw on a board: its middle (`h` in metres above the sea), the heading it faces, and how wide it may be. A shop's name over its front in a mall, `KITCHEN`, `ROOM 1`, `LIFT`, `MENU`, `CLASS 1`, `WARD 1`, `RECEPTION`. |
| `tills` | Where food is sold inside: within 4 m of one, a player's lunch box shows what the place sells, as beside a shop's name board outside (`use` is `food` or `shop`, `text` the shop's name: "Food and hearts"). |

A stroller's place is worked out from the shared clock, so everybody sees them in the same place: with
`L` the length of the path in metres, a pace of 0.9 m/s and a wait of 4 s at each end, one round takes
`P = 2 × (L / 0.9 + 4)` seconds, and at shared time `t` the stroller is `τ = (t + unit(id, 0x57414c4b) × P) mod P`
into it: walking out for `L / 0.9` s, standing 4 s, walking back, standing 4 s. Someone sitting or
standing only fidgets, as each game likes.

Everybody inside can be talked to like any animal: `talk` with `thing` their `id` and `sp` their animal,
and with `role` and `at` (the building's `x`, `y`, `id`) so that they know what they do there
("Talking").

## Things to show: `GET /v1/showcase`

A short list of what the world can do, for showing it to somebody, each with a real place where the
thing is right there (`server/src/showcase.ts`). Needs the access code or a player token, like the
chunks. The server keeps these places built, so a show starts at once.

```json
{"shows": [{"id": "train", "title": "Catch a train", "text": "Trains run through Glen Eden, and stop at its station.",
  "how": "When the train stops beside you, press E to hop on. E again hops off.",
  "find": "train", "place": {"name": "Glen Eden station, Auckland", "lat": -36.9109, "lon": 174.6568}, "keep": 3}]}
```

`find` says what to stand the player beside once the world at `place` has arrived:

- `train`: beside the track where a train is about to stand still (a station, or an end of its run),
  or failing that where one is about to pass. A game works this out from the trains in its labels and
  the shared clock; if none is due at the place within half a minute it goes along the line to one.
- `home`: the nearest `home` label whose `sp` is one of the show's `sp`. With `ride`, within reach
  of the animal (or boat, or tractor) itself.
- `car`: beside the nearest parked `car` label. `door`: on the path at the nearest `door` label.
- `air`: nothing to find: up in the air over the place, flying.

A game may use a thing of the same kind that is already near its player, and not travel at all.
`title`, `text` (what will be seen) and `how` (what to press) are for showing to the player. A game
should skip a show whose `find` it does not know.

## What is new: `GET /v1/news?since=0.2.42`

The release notes in plain words, for a card that a game shows on arriving
(`server/src/news.ts`). Needs the access code or a player token. `since` is the version whose
notes the player last saw: the answer has the releases after it, newest first, three at most. With
no `since` it has the newest three. `latest` is the newest version there are notes for; a game
keeps it as what its player has seen.

```json
{ "latest": "0.2.45",
  "news": [ { "version": "0.2.45", "date": "2026-11-23", "title": "Easier to find your way about",
              "items": [ { "text": "Taxis tell you a story on the way.", "in": "windows" } ] } ] }
```

`in`, when present, says that only one of the two games (`browser` or `windows`) has the thing
so far: the other game says so beside it.

## The street map: `GET /v1/maptile/{z}/{x}/{y}.png`

One square of a street map of the whole world, as a 256 by 256 PNG, for the world map a player looks
round and chooses a place from (N in both games; `server/public/js/worldmap.js` and `mapview.js`,
`EarthWorldMap.cpp`). The squares are the web's usual ones: zoom `z` from 0 (the whole world in one
picture) to 17, `x` east from the date line and `y` south, each from 0 to 2^z - 1. Needs the access
code or a player token, like the world's own data.

The pictures are OpenStreetMap's (`tile.openstreetmap.org`), fetched by the server, kept in
`maptiles/` in its cache for a fortnight and passed on (`server/src/maptiles.ts`): a game never asks
OpenStreetMap itself, so nobody outside learns which player looked at what. A caller gets 900 pictures in
five minutes (429 after that, with `Retry-After`); 404 for a square there is no picture of, 503 where
the map is turned off (`EARTHWALK_MAP_TILES=0`). A game must show "(c) OpenStreetMap contributors" on
the map itself, where it can be seen, as their tile usage policy asks.

A place chosen on the map is named by `GET /v1/place` (its neighbourhood, no closer), and gone to with
what there is already: `taxi` with `lat` and `lon`, a flight, or a jump.

## A suggestion: `POST /v1/suggest`

The suggestions box: what a player would like in the game, for whoever runs the server
(`server/src/suggestions.ts`). Needs the access code or a player token, and a body of JSON
(`Content-Type: application/json`, 4 KB at most):

```json
{ "text": "Boats to row across the harbour", "name": "Maple", "client": "windows", "lat": -36.841, "lon": 174.7683 }
```

Only `text` is needed (3 to 1000 characters). `name` is used for a guest; somebody signed in is known by
their account. `client` says which game it is from, `lat` and `lon` where the player stands. The answer is
`{ "ok": true, "id": 12 }`, or an `error` to show the player as it is: 400 for nothing said, 429 for more
than five in a day from one person.

## Place search: `GET /v1/geocode?q=...`

`200 {"name": "...", "lat": 48.85, "lon": 2.29}` or `404`. `q` may also be `"lat, lon"`.

A client should add where the asker is, `&lat=...&lon=...` (both games do, for "Go to..."). The place
is then looked for from there (`geocodeAround` in `server/src/geocode.ts`): somewhere the whole world
knows (Paris, the Eiffel Tower) is that place; otherwise the nearest of that name close by (4 km, then
25 km) when the words are an everyday place ("beach", "park"), begin with "the", are a name of several
words, or name a town or suburb there; otherwise the best known within some 300 km; and only then the
best known in the world. Without a position the best known in the world is given, as before: asked
alone, "the beach" is a district of Toronto and "beach" a town in North Dakota.

In both games "Go to..." while riding something that can be told where to go (a car, a taxi, a tractor,
an animal that carries) is said to it instead, as "take me to ...": it carries its rider there, along
the road when the place is close (see "Telling things what to do").

## Where am I: `GET /v1/place?lat=...&lon=...`

`200 {"name": "Montmartre, Paris", "country": "France"}`, either of which may be `null`. For the header
that tells a player where they are. The position is rounded to two decimal places (about a kilometre)
before it is looked up, and answers are remembered, so a client may ask again whenever its own rounded
position changes. It takes the same access code as the other routes.

## The weather: `GET /v1/weather?lat=...&lon=...`

The live weather of the district a player is in, from [Open-Meteo](https://open-meteo.com/)
(`server/src/weather.ts`). It takes the same access code as the other routes.

```json
{ "lat": -36.75, "lon": 174.75, "at": 1764000000000,
  "kind": "rain", "code": 63, "cloud": 0.9, "rain": 3.2, "snow": 0,
  "wind": 6.2, "gust": 11.3, "windFrom": 240, "temp": 14.2, "visibility": 9000,
  "day": true, "utcOffset": 46800,
  "credit": "Weather data by Open-Meteo.com", "creditUrl": "https://open-meteo.com/" }
```

| Field | What it is |
| --- | --- |
| `lat`, `lon` | The middle of the area this is the weather of. A position is rounded to a quarter of a degree (some 28 km) before anything is asked, and that is all the service is ever told of where anybody is. |
| `at` | When the service was asked, in milliseconds since 1970. An answer is kept a quarter of an hour and shared by everybody in the area. |
| `kind` | What to draw: `fine`, `cloudy`, `fog`, `drizzle`, `rain`, `snow` or `storm` (rain with thunder). Worked out from `code`. |
| `code` | The service's own code, from the World Meteorological Organization's table: 0 clear, 1 to 3 mainly clear to overcast, 45 and 48 fog, 51 to 57 drizzle, 61 to 67 rain, 71 to 77 snow, 80 to 82 showers, 85 and 86 snow showers, 95 to 99 thunder. |
| `cloud` | How much of the sky is cloud, 0 to 1. |
| `rain` | Rain and showers, in millimetres an hour. |
| `snow` | Snow, in centimetres an hour. |
| `wind`, `gust` | The wind ten metres up and its gusts, in metres a second. |
| `windFrom` | Where the wind blows from, in degrees: 0 north, 90 east. |
| `temp` | The air's temperature, in degrees Celsius. |
| `visibility` | How far one can see, in metres, or `null` when the service did not say. |
| `day` | The service's word on whether the sun is up there. (The games work the sun out for themselves: see below.) |
| `utcOffset` | How far the clocks there are from Greenwich, in seconds. |
| `credit`, `creditUrl` | The words and the link the service's licence (CC BY 4.0) asks for wherever its data are shown. Both games show them beside the map's credit while the real weather is on. |

`400` without a proper `lat` and `lon`. `503 {"error": "..."}` when there is no weather to give: the
service did not answer and nothing recent is kept for the area (an old answer does for two hours), the
day's ceiling of calls is spent (3,000; the service allows 10,000), or the server has the weather turned
off (`EARTHWALK_WEATHER=0`). `429` with `Retry-After` for one address asking about more than forty new
areas in ten minutes. **A game must carry on unchanged on anything but a `200`: it then has its fine
day.** A game asks when it arrives somewhere and every ten minutes or so after; asking again within
the quarter of an hour costs the service nothing.

The free service is for non-commercial use, which a family game with no adverts and nothing to pay is.
`EARTHWALK_WEATHER_URL` points the server at another copy of the service (the tests use a stand-in).

### The sun and the moon

Nothing is sent for these: each game works out where the sun and the moon stand from the place, the
date and the time, with the short sums of the Astronomical Almanac (`server/public/js/skymath.js`,
which `server/test/sky.test.ts` holds to known days), and lights the world from them: morning, noon,
evening, and a bright night with the moon in its real phase. `skyLight` in the same file is the light
for every height of the sun; the Windows game is to use the same numbers.

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
| `{"t":"pos","lat":..,"lon":..,"alt":..,"yaw":..}` | Where I am (feet, metres above sea level; yaw is a compass heading in degrees). Send about 10 times a second. Optional `"flown":true` says the player is being flown to a place by their game and is not travelling there themselves ("fly me there"): the room is told where they are as ever, and the server does nothing else about it. It counts no distance on foot, notes no place passed in the journal (the place they land in is noted when the first position without `flown` arrives), and downloads no map ahead of them: such a game asks for the chunks it can show and no others. |
| `{"t":"chat","text":"hello"}` | Say something to the room. |
| `{"t":"home"}` / `{"t":"home","lat":..,"lon":..,"name":"Eiffel Tower"}` | Signed-in only. Make where I stand my home (the server names the place), or the given place. Answered with a `home` message, or `error` `guest` / `nowhere`. |
| `{"t":"people"}` | Ask for the people list again (it is also pushed whenever it changes). |
| `{"t":"ride","thing":918398760,"sp":"horse"}` / `{"t":"ride"}` | Hop on something, or (with no `thing`) hop off. See "Riding". |
| `{"t":"talk","thing":918398760,"sp":"cow"}` / `{"t":"talk","thing":..,"sp":"cow","text":"what do you eat?"}` | Say hello to a thing, or say something to it. See "Talking". |
| `{"t":"taxi","place":"the beach"}` | Call a taxi to take me somewhere. See "Taxis". |
| `{"t":"guide"}` / `{"t":"guide","q":"where is the nearest station?"}` / `{"t":"guide","take":{"name":"..","lat":..,"lon":..}}` | Say hello to the guide, ask it a question in plain English, or have my ride take me to the place of its answer. See "The guide". |
| `{"t":"journal"}` | Ask for my own journal. See "Journal". |
| `{"t":"pet","sp":"cow"}` / `{"t":"pet"}` | Choose the companion that follows me, from those I have won, or send it home. See "Riddles and companions". |
| `{"t":"expedition","start":"hunt"}` / `{"t":"expedition","drop":"hunt"}` | Set out on the treasure hunt of where I stand (`hunt`) or on an expedition by its id (`farm`, `capitals`, `penguin`...), or give one up. The answer is my `journal`. See "Treasure hunts and expeditions". |
| `{"t":"play","make":"tag"}` / `{"t":"play","make":"hide"}` / `{"t":"play","make":"herd"}` / `{"t":"play","join":true}` / `{"t":"play","go":true}` / `{"t":"play","stop":true}` | Set up a game of tag or of hide and seek where I stand, join the one set up, start mine, or leave (my own: end it). See "Tag, and hide and seek". |
| `{"t":"race","make":true}` / `{"t":"race","join":true}` / `{"t":"race","go":true}` / `{"t":"race","stop":true}` | Set a race up where I stand, join the one set up, start mine, or leave (my own: end it). See "Races". |
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
| `{"t":"play","play":{..}}` / `{"t":"play","play":null}` | The game of tag or of hide and seek in this room, whole, whenever anything about it changes; null when it is cleared away. `welcome` carries it as `play`. |
| `{"t":"race","race":{..}}` / `{"t":"race","race":null}` | The race in this room, whole, whenever anything about it changes; null when it is cleared away. `welcome` carries it as `race`. |
| `{"t":"car","id":"..","thing":322932241,"body":"car","paint":15239605,"lat":..,"lon":..,"yaw":0}` / `{"t":"car","id":".."}` | A member's own car stands here, with this body and paint (a colour as a number); or has gone. Sent to the room; `welcome` lists them as `cars`. |
| `{"t":"hat","id":"..","hat":"cap"}` / `{"t":"hat","id":".."}` | A member has put a hat on, or taken it off. Sent to the room; `welcome` gives each peer's as `hat: "cap"`. |
| `{"t":"journal","journal":{..}}` | The answer to `journal`: the asker's own journal, or `null` on a server that keeps none. |
| `{"t":"guide","q":"..","text":"..","ai":false,"place":{..},"go":[..],"ask":[..]}` | The guide's answer, to the asker alone. See "The guide". |
| `{"t":"stamp","kind":"stamp","title":"Countries: 3","text":"You have visited 3 countries"}` | The player earned something, just now. `kind` is `stamp`, `country` (a country new to them; `title` is its name) or `level`. Sent to that player alone. |
| `{"t":"progress","level":{"n":3,"title":"Wanderer","points":52,"from":40,"next":90,"hint":"One new country to level 4"},"gained":3,"why":"fed a hungry cow"}` | The player's points rose, just now, or (with `gained` 0) this is where they stand as they come in. Sent to that player alone. See "Progress". |
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

Somebody inside a shop, an office or a mall ("Inside other buildings") is talked to in the same way, with
two more fields: `{"t": "talk", "thing": 2863311530, "sp": "rabbit", "role": "barista", "at": {"x": 33185, "y": 22545, "id": 25412345}}`.
`role` is theirs from `GET /v1/inside`, and `at` the building. With a `role` the server knows (any other is
ignored, and they answer as the animal they are), their hello and their stock lines are about what they do
there (`ROLES` in `server/src/talk.ts`), the AI is told of it, and the place is called by its name, which the
server reads from what it kept when it built that inside (never from the message). `owl` can be talked to
as well, being one of the six.

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
| `goto` | the asker alone | Only for a thing the asker is riding (seat 0). `name`, `lat`, `lon` are the place, found near the rider first and then anywhere; `path`, when present, is the way there by road as `[lat, lon]` points about 8 m apart, on the car's own side of the road (cars, taxis and tractors). A place within 2.5 km is given the whole way. A place further off, up to 10 km, is a long drive and comes a leg at a time: `more: true` says `path` ends on the way to the place and not at it, and as the rider comes within 400 m of that end the server sends another `goto` for the same thing, marked `onward: true`, whose `path` carries on from there (with `more` again, until the last). A client that is no longer being driven by that thing (the rider took the wheel) ignores an `onward` order; one that reaches the end of a `more` path with nothing further (no road goes on: water, or a map that is slow to come) waits there a few seconds and does the rest in one jump. The way starts and ends on a proper street when one is within reach, not up a driveway or a car park aisle, which often end against a wall; a taxi waits at that same point of the street. The rider's own client carries them: along `path`, or straight across country on an animal when the place is within 1.5 km, or in one jump (hop off, travel, hop on again). Friends see it through `ride` and the positions already shared. |

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
- `taxi` may carry `lat` and `lon` as well as `place`, when the game already knows where the
  place is (from an answer of the guide's): the taxi is then sent there and the name is not looked up.
- A place by name is looked for within about 4 km of the caller first, and of what is found there
  the nearest is taken ("the beach" is the beach down the road, not the best known one in the
  region); failing that, the same within about 25 km; failing that, the best match anywhere.
- When someone hops on (`ride` with `sp` `taxi`; refused with `taken` for a taxi that is not
  waiting), whoever takes seat 0 is the fare: after the `ride` message they are sent an `order` with
  `act` `goto` for the place asked for, and their client carries them there as for any "take me to"
  ("Doing as asked"). Friends who hop on too ride along.
- While the fare is aboard the taxi says something of its own, ten times at most: a `say` with no
  `q`, heard like any other. The first four, about a quarter of a minute apart, are the parts of
  one story about a fare it once carried (a different story each ride); the rest, about every half
  minute, are remarks. With the AI these come from the same character that answers when it is talked
  to; without it, from a stock of twelve stories and of remarks (`server/src/talk.ts`). A game
  should keep such a bubble with the taxi as it drives.
- When the fare gets out the ride is over: the taxi stands where it stopped for a minute, like
  anything a rider has left, and is then gone. A taxi nobody boards, or whose caller leaves or calls
  another, goes with `gone`.

`welcome` carries `taxis`: those still waiting. One call every 15 seconds a player.

**Agility.** `{"t":"race","make":"agility"}` sets up, for a player with a companion, an agility course
where they stand: a race whose `kind` is `"agility"`, with nine `gates` in a ring some twenty metres
across before them, `reach` (3.2 m: how near a gate counts as passing it) and `obstacles`, what each
gate is: `start`, `jump`, `hoop`, `weave`, `tunnel`, `table`, `finish`. Everything else is as for a
race (join, go, stop, the countdown, gates in order). A finished round is paid for and the quickest
kept; the journal's `agility` has `runs` and `bestSeconds`. Clients are expected to draw each obstacle.

### The guide

A player asks, in plain English, where they are or how to get somewhere, and is told in a sentence or
two, with buttons that start the trip (`server/src/guide.ts`). The key is Q in both games ("Ask the
guide..." in the menu). Everything goes over the meetup connection, because the server already knows
there where the asker stands and what they are riding. Answers go to the asker alone.

Client to server:

| Message | Meaning |
| --- | --- |
| `{"t":"guide"}` | Hello: the guide says what it can be asked, and offers questions to click. Free, and never the AI. |
| `{"t":"guide","q":"where is the nearest station?"}` | A question, 200 characters at most. |
| `{"t":"guide","take":{"name":"Four Square","lat":-36.8301,"lon":174.7969}}` | "Take me there": have what I am riding carry me to the place of an answer. Answered like a "take me to" said to the ride itself ("Doing as asked"): a `say` from the ride and an `order` with `act` `goto` for the asker, or `error` `nowhere` when they are not at the reins of something that can carry them. |
| `{"t":"taxi","place":"Four Square","lat":-36.8301,"lon":174.7969}` | "Call a taxi": `taxi` may say where the place is, when the game knows (from an answer's `place`); the server then does not look the name up. |

Server to client:

```json
{"t": "guide", "q": "is there a shop near here?", "ai": false,
 "text": "The nearest shop is Four Square, 120 m to the north. There is also Devonport Chocolates, 310 m to the east.",
 "place": {"name": "Four Square", "kind": "shop", "lat": -36.8301, "lon": 174.7969, "metres": 120, "dir": "north", "road": 180},
 "go": [{"act": "taxi", "label": "Call a taxi"}],
 "ask": ["What is near here?", "What can I do here?"]}
```

- `text` is the answer, for the conversation bubble; `q` is the question it answers (absent for the
  hello). `ai` says whether the AI put it into words; a game need not care.
- `place`, when the answer is about one place, is what a game needs to act on it: its `name`, where it
  is, how far off as the crow flies (`metres`) and which way (`dir`, one of the eight compass points:
  `north`, `north-east`...). `kind` is `shop`, `food`, `place` (any other named building), `station`
  (a train stops there), `door` (a house that can be gone into), `ride` (an animal, a tractor, a boat
  or a parked car to hop on), `animal`, `found` (a place looked up by name) or `show` (one of
  "Things to show"). `road` is how far it is by road in metres, present only when the server found a
  way (places within 2.5 km: `server/src/route.ts`; a place further off, up to 10 km, is driven a leg at a time and its road is not worked out ahead for the guide).
- `go` is the buttons to put under the answer, in order, each with the words to show. What each `act`
  means for a game:

| `act` | Shown as | What the game does |
| --- | --- | --- |
| `take` | Take me there | Sends `guide` with `take` and the answer's `place`. Offered only while the asker has the reins (seat 0) of something that can carry them: an animal that can be ridden, a car, a tractor, a taxi. |
| `taxi` | Call a taxi | Sends `taxi` with the place's `name`, `lat` and `lon`. Offered on foot, for places from 150 m to 20 km off. |
| `jump` | Go there now | Travels to `lat`, `lon` at once, as "Go to a place..." does. Offered for places more than a kilometre off. |
| `show` | Show me | Goes to the "Show me" entry whose id is the button's `show` (`{"act":"show","label":"Show me","show":"camel"}`), as picking it from that list does. |

  A game should skip a button whose `act` it does not know.
- `ask` is up to six questions to offer as buttons; a click sends one as `q`.

What it can be asked, and what it answers from. Nothing here needs the AI:

| Question | Answered from |
| --- | --- |
| "Where am I?" | The name of the place and its country (as `GET /v1/place`), and the nearest street sign within 150 m. |
| "What is near here?" | The labels of the nine chunks round the asker, as the server has them built: named buildings (shops and places to eat said to be so), where trains stop, the nearest door that opens, parked car, and animal, tractor or boat of each kind. Nearest first, each with its distance and direction. |
| "Is there a shop near here?", "Where is the nearest station?", "Where can I find a horse?", "I'm hungry" | The nearest of that kind among the same things. Failing one, a "Show me" entry that has it, and for shops, food and stations what the place search finds within 30 km. |
| "How do I get to the beach?", "How far is the Sky Tower?", "Where is Queen Street?" | The place by name: among the things near first, then the place search (round the asker first, as for a taxi). Its distance and direction, and for a place within 2.5 km whether there is a way by road and how long it is. |
| "What can I do here?" | Today's tasks not yet done, what is near to ride, go into, buy food at or catch, and the "Show me" list. |
| "How far is it?", "Take me there" | The place of the answer before. |

When it does not know, it says so: "I could not find...", "I do not know of a shop near here".
The labels are read from what is already built and never built for a question, so somewhere a
player has only just arrived the guide may know less for a moment.

With `ANTHROPIC_API_KEY` set on the server, and while the day's allowance lasts (the same allowance
as "Talking"), the same facts are handed to Claude with the question, and it answers in two or
three short sentences a child can read. It is told to use only those facts: it names its answer's
place by the fact's id, and the server takes `place` and the buttons from that fact, never from the
model's words. A place asked for by name that is not among the facts is handed back to be looked
up, and then answered by the built-in rules. If the service fails, declines or says something the
server cannot use, the built-in answer goes out instead.

- What goes to the AI service: the question as typed, the asker's animal ("a fox", never their
  name), what they are riding, the area's name, the facts listed above, today's tasks, and the last
  three questions and answers of this visit (kept in memory only).
- At most 12 `guide` and `talk` messages a minute per player together, and not two within 1.2 s
  (`error` code `slow`).

### Tag, and hide and seek

A room has at most one of these at a time, and not while a race is on (`server/src/play.ts`). `play`
with `make` sets one up, on a field round where its maker stands (90 m for tag, 140 m for hide and
seek). Others `join` while it is open; its maker says `go` (refused with fewer than two players),
and play begins five seconds later. The object is `{ kind, by, byName, lat, lon, radius, state,
made, startAt, seekAt, endAt, ended, it, since, safe, players: [{ id, name, itMs, found, out }] }`,
with times in the server's clock and `state` one of `open`, `go`, `over`.

The server judges from the `pos` messages it already gets; nothing a client says tags or finds
anyone.

- **Tag.** `it` is picked by lot. When it comes within 3 m of another player (and within 3 m of
  their height), that player is it instead; `safe` names the one who cannot be tagged back for three
  seconds. A player more than five seconds outside the field becomes it. After three minutes the
  game is over, and whoever was it for the least time (`itMs`) has won.
- **Hide and seek.** `it` is the seeker. Until `seekAt` (half a minute) nothing can happen to the
  hiders, and the seeker's client shows them nothing. After it, a hider within 4.5 m of the seeker
  (and 4 m of their height) is found (`found` is when); so is one more than five seconds outside the
  field. It is over when all are found (the seeker has won) or at `endAt`, four minutes on (anyone
  still hidden has won).

- **A round-up** (`herd`). Played together, or alone. `radius` (9 m) is a pen round where it was set
  up, and `goal` how many animals are wanted (five for one player, two more for each friend, a dozen
  at most). An animal that is following a player (an `order` of `follow` by them, as from "follow me"
  in a `talk`) counts when that player stands in the pen: its identity joins `penned`, the player's
  `itMs` counts one more (it is their tally here), and the room is sent an `order` of `stay` placing
  the animal in the pen. While a round-up is on, a `talk` of exactly "follow me" is answered in plain
  words at once, with no AI. It is won when `goal` are in and ends after five minutes either way;
  everyone is paid alike. When the game is cleared the animals are sent `home`.

Clients are expected to mark out the field, show who is it, give "it" at tag a little more speed
(the browser: a fifth), and not to draw name labels over hiders for the seeker. Each player is told
how it came out with a `stamp` of kind `play`: ten coins for playing and more for winning or
finding. Leaving is `stop`; a game ends with its maker, or when too few are left.

### Races

A room has at most one race (`server/src/race.ts`). `race` with `make` sets one up near where its
maker stands: the server plans a course by road of 350 to 1600 m, with a gate about every 120 m
(refused with `error` code `nowhere` where there are no roads). Anyone in the room may `join` while
it is open; its maker says `go`, and it begins five seconds later. The race object is `{ by,
byName, gates: [[lat, lon], ..], metres, state, startAt, made, ended, runners: [{ id, name, gate,
time }] }`: `state` is `open`, `go` or `over`; `startAt` is in the server's time (the shared clock);
a runner's `gate` is how many gates they have passed and `time` their time in milliseconds once
finished.

Runners go by any means. The server watches their `pos` messages: a gate counts when a runner is
within 22 m of it, in turn, and only once the race has begun, so everyone must come through the
start gate first. Each gate passed is told to the room with `race`. A finisher is told with a
`stamp` of kind `race`; finishing pays 15 coins and beating somebody 15 more. When every runner has
finished the state is `over` and the results stay for a minute. `stop` takes a runner out; from
its maker (or when its maker leaves the room) it ends the race. A race nobody starts is cleared
after ten minutes, and one nobody finishes after twenty.

### Hungry animals

On any day about one animal in five is hungry for one food: which, and for what, is
`hungerOf(sp, thing, day)` in `server/public/js/care.js` (a hash of the animal's identity and the day
number, the player's own day as for the daily tasks; a table says what each kind likes). Games are
expected to mark the hungry ones nearby. A `talk` to a hungry animal by a player who has that food in
their lunch box feeds it: the food goes, twelve coins come, and it is not hungry for that player
again that day. Without the food, the player is told what it would like. News comes as `stamp`
messages of kind `care`. The journal's `care` has `fed` (in all), `today` (those fed today, as
`"horse:918398760"`), `coins`, and `next` (how many fed wins which companion, or null). A hungry
animal gives no food of its own until it has been fed.

### Tricks

The companion at a player's side (see "Riddles and companions") can be taught tricks, in this order:
`sit`, `spin`, `jump`, `bow`, `fetch`, `hoop`, `dance`. Each kind of companion keeps its own.

| Message | Meaning |
| --- | --- |
| `{"t":"trick","learn":"sit"}` | Begin a lesson in the next trick my companion can learn. |
| `{"t":"trick","presses":[1830,2950,4170]}` | My presses for the lesson under way, in milliseconds from when it was set. |
| `{"t":"trick","do":"sit"}` | Have it do a trick it knows. |

A lesson is set with `{"t":"lesson","trick":"sit","name":"Sit up","beats":[1800,2900,4150],"slack":380}`:
the beats in milliseconds from now, and how near a beat a press must fall. The presses are marked by the
server (each beat met by at most one press; all but one beat must be met, with no more than two presses
to spare, and not before the last beat has had time to come) and answered with
`{"t":"lesson","trick":"sit","name":"Sit up","done":true,"passed":true,"hits":3,"of":3}`. A lesson
that does not come off costs nothing. When one does, the journal follows, and a `stamp` of kind `trick`.

Whenever a companion does a trick (asked for, or just learnt) the room is sent
`{"t":"trick","id":"<member id>","thing":2499031538,"sp":"cow","trick":"sit"}`, and every game draws it.
The journal's `tricks` has `pet` (the companion, or null), `all` (each `id`, `name`, `known`), `next` and
`coins`. Errors are `locked`, with words saying why.

### Food and hearts

A player has five hearts, one for each kind of good food: `fruit`, `veg`, `grain`, `protein`, `dairy`.
Eating fills them for the day (the player's own day, as with the daily tasks); nothing empties them but
midnight, and nothing bad comes of empty ones. Food is carried in a lunch box of thirty things, kept
in the journal. A `talk` to a thing that has food to give puts it in the lunch box, once a day from
each thing (a cow milk, a hen an egg, one tree in three its fruit); so does a favour done.

| Message | Meaning |
| --- | --- |
| `{"t":"food","eat":"milk"}` | Eat one of these from my lunch box. |
| `{"t":"food","menu":"food"}` | What is sold where I am: `"shop"` for a shop, `"food"` for somewhere to eat. |
| `{"t":"food","buy":"sushi","at":"food"}` | Buy one, from a shop or (`at` `"food"`) somewhere to eat, into my lunch box. It must be on that menu. |
| `{"t":"food","cook":"sandwich"}` | Cook a recipe from what is in my lunch box: two helpings of the meal come in place of what it needs. Only within 40 m of the door of a house of my own, and only a recipe I know. |
| `{"t":"food","give":"sandwich","to":"<member id>"}` | Give one of these to a player in my room who is within 20 m. Both are sent their `journal`, and both a `stamp` of kind `food`. |

The answers: after eating, `{"t":"pep","on":true}` (true once all five hearts are full today: the
player may then go about a tenth quicker on foot; it is also sent, true, on joining later the same
day) and the `journal`; after buying, the `journal`; and for a menu

```json
{"t":"menu","use":"food","country":"Japan","items":[{"id":"sushi","name":"a plate of sushi","groups":["grain","protein"],"price":16}]}
```

A café's menu begins with the dishes of the country the player is in. News of food comes as `stamp`
messages of kind `food`. The journal's `food` has `hearts` (the five, each `group`, `title`, `full`),
`full`, `healthyDays`, `coinsFull`, `larder` (each `id`, `name`, `groups`, `n`), `room`, and `recipes`
(each `id`, the meal's `name` and `groups`, `makes`, `needs` as words with whether the lunch box `have`s
each, `known`, `can` and `times`; three are known at first, and each cooked for the first time makes
the next one known). A `sign`
label of a shop or of somewhere to eat carries `use`: `"shop"` or `"food"`. Clients are expected to
show the hearts, let the player eat from the lunch box, and offer the menu beside such a sign.

### A house of your own

Any house that opens (see "Inside houses") can be made a player's own. One house a person; a guest's
is theirs until they leave. Houses are in the world, not in a room: everybody connected is told of them.

| Message | Meaning |
| --- | --- |
| `{"t":"house","claim":{"x":33638,"y":21638,"id":269982566}}` | Make this house mine: the chunk it is in and its number there (the `id` of its `door` label). The sender must be within 80 m of its door. A house they had before is given up, and its furnishing comes along. |
| `{"t":"house","leave":true}` | Give my house up. |
| `{"t":"house","put":{"slot":"sofa","id":"royal"}}` | Swap a piece: `slot` is `walls`, `floor`, `sofa`, `bed` or `rug`, and `id` a piece of that slot (bought now with coins if it is not theirs yet); without `id`, what the house came with goes back. |
| `{"t":"house","put":{"slot":"prize","id":"piano","on":true}}` | Put a prize on show, or (`on` false) away. Ten at most stand in a house. |
| `{"t":"house","place":{"id":"piano"}}` | Put something that is on show down a step in front of where I stand in my house, facing me. With `"turn":true` it is turned a quarter round where it is; with `"wall":true` it goes back to standing against a wall. |

The server answers the sender with `{"t":"house","house":…}`: null, or their house as below with
`decor` (`{walls?, floor?, sofa?, bed?, rug?, prizes: [], placed?}`, where `placed` gives, for things put
somewhere by their owner, the middle of each in metres along the front wall (`a`) and back from it (`b`)
and which way it faces (`k`, 0 to 3); the server works these out from where the owner stands), and after a `put` with their `journal`
again (the coins have changed). Everybody, in every room, is sent

```json
{"t":"lived","x":33638,"y":21638,"id":269982566,"lat":52.0310154,"lon":4.7796697,"yaw":332.3,"name":"Sam","rev":3}
```

when a house is moved into or furnished anew (`lat`, `lon` its front door, `yaw` the compass heading
that leads out of it, `name` its owner's, `rev` counting its changes), and
`{"t":"lived","x":…,"y":…,"id":…,"gone":true}` when it is empty again. `welcome` carries the same list
as `lived`, and the player's own as `house`. Errors: `nowhere`, `nohome` (no such house, or none of
their own), `far`, `taken`, `many`, `poor`, `locked` (no such piece, or a prize not won yet), `busy`.

**Reading a plan off a picture: `POST /v1/plan`.** The body is the picture itself (`Content-Type`
`image/png`, `image/jpeg`, `image/webp`, `image/gif` or `application/pdf`, four megabytes at most), sent
by somebody signed in (their token as for `/v1/journal`) who has a house. The answer is
`{"plan":{…},"notes":["…"],"lines":["Ground floor: …"],"left":2}`: the plan to send back in a `house`
message if they want it built, what had to be changed, the plan in words, and how many tries they have
left today (three a day). Errors carry `error` in words: 401 not signed in, 409 no house, 413 too
big, 415 not a picture, 422 not a floor plan or nothing to build, 429 no tries left, 502 the reading
failed (the try is given back), 503 no AI on this server or its allowance spent for today.

**A plan of one's own.** `{"t":"house","plan":{…}}` gives my house a floor plan (the object the server
made when it read my picture: `floors`, each with `rooms` (`name`, `kind`, and `a0`, `a1`, `b0`, `b1` in
metres from the front door: `a` along the front wall, `b` back into the house) and `doors` (pairs of
rooms); `entrance`, the room behind the front door; `stairs`, or null). It is checked again and refused
if it cannot be built. `"plan":null` goes back to the rooms the house was built with. A house with a
plan is told to everybody with `lift` (3000) and `floors`: its inside stands `lift` metres above the
real house, is fetched with `GET /v1/interior/16/x/y/id?r=<rev>&plan=1`, and a player going in at its
front door is to be put on its floor up there (and set down in the street on coming out). Without
`plan=1` the same address gives the house's ordinary rooms. The owner's `house` also has `planned`,
the plan in words, a line a floor.

**The garden.** A house's owner may keep up to four young animals before its front door.

| Message | Meaning |
| --- | --- |
| `{"t":"garden","adopt":"chicken"}` | Buy a young one: `chicken`, `sheep`, `pig` or `cow`. |
| `{"t":"garden","feed":0}` | Feed the one at this place in my garden, once a day, with something plain from my lunch box (vegetables first, then grain, then fruit). |
| `{"t":"garden","gather":0}` | Take what a grown one gives, once a day: food into my lunch box, or coins. |
| `{"t":"garden","release":0}` | Send one away, to make room. |

Each is answered with a `stamp` of kind `care` saying what happened, then `house` and `journal`, and
everybody is sent the house again as `lived`, now with `garden`: each animal's `sp` and `size` (0.45
when it comes, 1 when grown). The owner's `house` also has `animals` (each `sp`, `name`, `fed`, `meals`,
`grown`, `hungry` today, `ready` to give today, `gives`), `breeds` (what can be bought, with `price` and
`meals`) and `gardenMax`. A garden does not change `rev`. Games are expected to draw the animals a few
metres out from the door, each at its size.

The pieces there are come in the journal as `house.pieces`: `id`, `slot`, `name`, `price` (null for a
prize that is won, with `how` in words), `owned`, and `hex`, its colours.

`GET /v1/interior/16/x/y/id` of a house somebody lives in gives its rooms furnished their way, and is
not to be cached: fetch it again when `rev` changes (the browser adds `?r=<rev>`). Clients are
expected to put the owner's name over the door ("Sam's house"), and to let its owner choose pieces.

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
| `level` | `{ n, title, points, from, next, hint }`: the level, its name, the points so far, the points at which this level began and the next begins, and the nearest next step in a few words (see "Progress") |
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

### Progress

Every journal adds up to points, and points to a level (`level` in the journal). So that a game can keep
a bar on screen without asking for the whole journal, the server says so the moment points are earned:

```json
{"t":"progress","level":{"n":3,"title":"Wanderer","points":52,"from":40,"next":90,"hint":"One new country to level 4"},
 "gained":3,"why":"fed a hungry cow"}
```

| Field | Meaning |
| --- | --- |
| `level` | The same object as the journal's `level`. The bar is `(points - from) / (next - from)` full. |
| `level.hint` | The nearest next step to the level after this one, as a sentence to show as it is: "Two new places to level 4", "Three new friends to level 4", "One new country to level 5", "Solve one riddle for level 4", "Fill your last two hearts for level 3". Whatever it names is always enough. |
| `gained` | The points just earned. 0 in the one sent right after `welcome` (once the journal is open), which only says where the player stands. |
| `why` | In a few words, lower case, what earned them: "fed a hungry cow", "a new country: France", "met your first hedgehog", "made friends with Daisy", "a new place: Montmartre", "filled a heart", "filled all five hearts", "cooked a meal", "taught a trick", "walked a kilometre", "a new stamp"... When several things rose at once it names the one most worth saying. `null` when `gained` is 0. |
| `up` | Only when these points reached a new level: `{ n, title, coins, riddles }`, the level, its name, the coins it paid and how many riddles it opened. |

It goes to that player alone, after any `stamp` messages of the same moment (a new level is still told
as a `stamp` of kind `level`, whose text now names the coins, for games that show no bar). A server that
keeps no journals sends none.

What earns points (`server/src/progress.ts`): a new country 10, a continent 15, a place 2, a kilometre
on foot 1, two kilometres ridden 1, a new friend 1, a new kind of friend 3, a new kind of thing ridden
3, a stamp 2, a riddle 6, a day with all three tasks done 5, a favour 4, a treasure 6, an expedition 8,
a race 3 and winning one 4 more, a game 3 and winning one 3 more; and for looking after yourself and
others: a heart filled 1, a day with all five full 5 more, a hungry animal fed 3, a meal cooked 2, a
trick taught 3, an agility round 2. Level `n` begins at `10 * (n - 1)^2` points. A new level pays
`10 * n` coins, once, and opens the riddles of that level. Points are only ever added: nothing takes
them away, and no level locks anybody out of anything but riddles not yet opened.

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
