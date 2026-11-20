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

### Without Docker

If you would rather not use the Dockerfile, choose the Node runtime instead and set:

- **Build Command**: `npm ci --omit=dev`
- **Start Command**: `npm start`
- Environment variables as above, plus `NODE_VERSION` = `24`,
  `EARTHWALK_TRUST_PROXY` = `1` and `EARTHWALK_CACHE` = `/data`.

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
code) in `%LOCALAPPDATA%\EarthWalk`, separately from the editor's. The server does not
need to change when the game is updated, and old and new game versions can share a room.

## Inviting someone

1. Open your server's address in a browser, enter your name, pick an animal, and
   enter the access code.
2. Type `/invite` in the chat box. It copies a link that already contains the room
   and the access code.
3. Send that link to the other person. They open it, type a name, pick an animal,
   and they are in your room. `/join <name>` takes either of you to the other.

Anyone with the link can join, so share it the way you would share a house key.
To lock everyone out, change `EARTHWALK_ACCESS_CODE` on the host and redeploy.

## Things to know

- **First visit to a new place is slow** (several seconds) while the server downloads
  and builds it. After that it is served from the disk.
- **Be gentle with the map services.** They are free and shared. The server spaces
  out its requests, caches everything, and limits how fast one person can make it
  build new areas.
- **Other hosts** (Railway, Fly.io, a VPS) work the same way: build `server/Dockerfile`,
  set the two variables, mount a disk at `/data`, and expose the port in `PORT`.
