# Hosting the world server

The server is one long-running Node.js program. A host needs to give it:

- Node.js 22.18 or newer (the included `server/Dockerfile` uses Node 24),
- WebSocket support (for seeing each other and chat),
- outbound internet access (it downloads map and elevation data),
- ideally a persistent disk, so downloaded data and built areas survive restarts.

Any host that can build a Dockerfile from a GitHub repository will do. The steps below
use [Render](https://render.com) as the example. Plans and prices change, so check
their pricing page before you start. At the time of writing, the free web service
sleeps when idle and cannot have a disk, so the smallest paid instance is the one to use.

The family server is running this way at https://earthwalk.onrender.com (first deployed
from `server/Dockerfile` on Render without changes).

## Deploy on Render

1. Sign in at render.com with your GitHub account and allow it to see the
   `earthwalk` repository.
2. **New > Web Service**, and pick the `earthwalk` repository.
3. Settings:
   - **Branch**: `main`
   - **Root Directory**: `server`
   - **Language / Runtime**: Docker (it finds `server/Dockerfile`)
   - **Instance type**: the smallest paid one (an instance that does not sleep)
4. **Environment variables**:
   - `EARTHWALK_ACCESS_CODE`: a password you make up. Everyone who joins needs it.
     Without it, anyone who finds the address can use your server.
   - `EARTHWALK_CONTACT`: an email address or web page for you. It is sent to the
     OpenStreetMap services with each request, as their usage policies ask.
5. **Disk** (under Advanced): add one, 1 GB is plenty to start, mounted at `/data`.
6. Create the service and wait for the first deploy to finish.
7. Open `https://<your-service>.onrender.com/health`. You should see
   `{"ok":true, ..., "codeRequired":true}`.

Render sets the `PORT` variable itself and the server listens on it.

## Sign in with Google

Without this, everyone is a guest who types a name and the access code. With it, family
members sign in with their Google account once per device, are remembered, get a home to
start from (`/home`), and can see who is online and where (`/who`, and the people panel in
the browser). It takes one free OAuth client in Google Cloud and three environment variables.

1. Go to [console.cloud.google.com](https://console.cloud.google.com), make a project
   (any name, e.g. "EarthWalk"), and open **APIs & Services**.
2. **OAuth consent screen** (in newer consoles: *Google Auth Platform > Branding* and *Audience*):
   - App name "EarthWalk", your email as the support and developer contact.
   - **Audience / User type: External.** The app can stay in *Testing*: then only people you
     add under **Test users** can sign in (up to 100), which suits a family server fine. If
     you would rather not list them there, press **Publish app** instead; the app asks only
     for name and email, so no verification is needed.
   - Scopes: nothing to add (`openid`, `email` and `profile` are always available).
3. **Credentials > Create credentials > OAuth client ID**:
   - Application type: **Web application**.
   - **Authorised redirect URIs**: `https://<your-service>.onrender.com/auth/google/callback`
     (and `http://localhost:8787/auth/google/callback` if you also run the server on your PC).
   - Copy the **Client ID** and **Client secret**.
4. Add these environment variables to the service on Render (it redeploys by itself):

   | Variable | Value |
   | --- | --- |
   | `EARTHWALK_GOOGLE_CLIENT_ID` | the client id from step 3 (ends in `.apps.googleusercontent.com`) |
   | `EARTHWALK_GOOGLE_CLIENT_SECRET` | the client secret from step 3 |
   | `EARTHWALK_BASE_URL` | `https://<your-service>.onrender.com`: the address Google sends people back to, no trailing slash |
   | `EARTHWALK_INVITED` | optional: emails that may sign up without the access code, comma-separated |

5. Open the server's address: the join screen now has **Sign in with Google**, and
   `/health` says `"googleSignIn": true`.

**Who may sign up.** A Google account the server has not seen before is accepted when either
its email is in `EARTHWALK_INVITED` or the sign-in carried the access code (the browser join
screen passes the code typed into its box; the game passes the code set with `/code`). So the
access code stays the one house key: invite people exactly as before, and they can sign in
with Google on top. Once an account is known it signs in without the code. If the server has
no access code at all, anyone can sign up (as anyone can already join).

**Where it is stored.** People, their homes and the hashes of their sign-in tokens live in
`people/people.json` under the cache directory (`/data` on Render), so they survive restarts
and redeploys as long as the disk does. To remove someone, delete their entry from that file
and restart; their tokens stop working at once because they point at the entry.

**The Windows game** has no Google login of its own. Type `/login` in the game: it opens your
browser at the server's sign-in page, and once you have signed in there the game picks up its
token within a few seconds and remembers it. `/logout` forgets it. The game needs no access
code once it is signed in.

### Without Docker

If you would rather not use the Dockerfile, choose the Node runtime instead and set:

- **Build Command**: `npm ci --omit=dev`
- **Start Command**: `npm start`
- Environment variables as above, plus `NODE_VERSION` = `24`,
  `EARTHWALK_TRUST_PROXY` = `1` and `EARTHWALK_CACHE` = `/data`.

## Talking things (optional, the one part that costs money to run)

Everything in the world can be talked to. Out of the box each thing has a name, a character and a
small stock of lines, and that costs nothing. To have them answer properly, in their own words, the
server asks Claude, Anthropic's AI, and that is paid for by use:

1. Make an account at https://console.anthropic.com, add some credit, and create an API key.
2. In Render, open the service's **Environment** page and add `ANTHROPIC_API_KEY` with that key as its
   value. Never put the key in the repository. Render restarts the server; `/health` then shows
   `"talking": true`.

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | The key. Without it things use their stock lines and nothing is spent. |
| `EARTHWALK_TALK_MONTHLY_USD` | The most to spend in a month, in US dollars (default 25). A thirtieth of it may be spent each day; after that things fall back on their stock lines until midnight UTC. The server keeps its own count from what each answer cost, so set a limit in the Anthropic console too. |
| `EARTHWALK_TALK_MODEL` | Which Claude answers (default `claude-opus-5-5`). `claude-sonnet-5-5` costs about half as much and `claude-haiku-5-5` about a fortieth, for simpler wit. |

Roughly: an answer on the default model costs about one US cent, so the default limit allows about 85
answers a day; on `claude-haiku-5-5` the same money buys a few thousand. These are estimates; prices
change, so check Anthropic's pricing page.

What is sent to Anthropic for each answer: the character's description, the name of the area (about a
kilometre across), the last few lines of that conversation, and what the player typed, attributed to
the animal they play ("A fox says..."), not to their name. Nothing is sent for a hello, or when the
key is not set. The characters are told to keep it short, kind and suitable for young children, to
stay out of real-world politics, and not to ask for personal details; see `systemPrompt` in
`server/src/talk.ts` to change any of that.

## Sharing the Windows game

The Unreal game is turned into a normal Windows program by *packaging* it. One person
with Unreal Engine installed does this; everyone else just installs the result.

1. Install [Inno Setup](https://jrsoftware.org/isinfo.php) once, which makes the installer:
   `winget install JRSoftware.InnoSetup`.
2. Close the Unreal editor and double-click `game\package.cmd`. The first run takes
   10-20 minutes (it compiles the game and prepares engine content). It writes
   `game\Packaged\Windows\EarthWalk.exe` (the game folder, runnable as is) and
   `game\Packaged\EarthWalk-Setup-<version>.exe` (the installer). Details go to
   `game\package-log.txt`.
3. Publish the installer as a GitHub release, so there is one link to send:

   ```powershell
   gh release create v0.1.0 game\Packaged\EarthWalk-Setup-0.1.0.exe --title "EarthWalk 0.1.0" --notes "First Windows release."
   ```

   (`gh` is the GitHub CLI. Without it, open the repository on GitHub, choose Releases,
   Draft a new release, and attach the file.)
4. Send the release link. The installer puts the game in Program Files and the Start menu,
   and an uninstaller in Windows Settings.

The version number comes from `ProjectVersion` in `game/Config/DefaultGame.ini`; raise it
before packaging a new release. The game remembers its own settings (name, animal, access
code, sign-in token, home) in `%LOCALAPPDATA%\EarthWalk`, separately from the editor's. The server does not
need to change when the game is updated, and old and new game versions can share a room.

## Inviting someone

1. Open your server's address in a browser, enter your name, pick an animal, and
   enter the access code.
2. Type `/invite` in the chat box. It copies a link that already contains the room
   and the access code.
3. Send that link to the other person. They open it, type a name, pick an animal,
   and they are in your room. `/join <name>` takes either of you to the other.

Anyone with the link can join, so share it the way you would share a house key.
To lock everyone out, change `EARTHWALK_ACCESS_CODE` on the host and redeploy. People who
signed in with Google keep their sign-in; remove them from `people.json` as described above.

## Things to know

- **First visit to a new place is slow** (several seconds) while the server downloads
  and builds it. After that it is served from the disk.
- **Be gentle with the map services.** They are free and shared. The server spaces
  out its requests, caches everything, and limits how fast one person can make it
  build new areas.
- **Other hosts** (Railway, Fly.io, a VPS) work the same way: build `server/Dockerfile`,
  set the two variables, mount a disk at `/data`, and expose the port in `PORT`.
