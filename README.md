# D&D Music Manager — Project Reference

> **Disclaimer:** This is a fully vibed app built with Claude Sonnet 4.6!

## Purpose

A self-hosted web application for managing and playing music during tabletop RPG (D&D) sessions. 
The DM can upload audio tracks, organise them into a Campaign → Session → Track hierarchy, tag them for quick filtering, and control playback from a persistent bottom player bar — including looping, crossfading, volume control, and simultaneous layered playback.

---

## Quick Start

```bash
docker compose up --build
```

Open **http://localhost:8080** in your browser.

Data persists across restarts via Docker named volumes (see [Docker & Deployment](#docker--deployment)).

---

## Repository Layout

```
dnd-music-manager/
├── Dockerfile                  # Multi-stage build: Go builder → Alpine runtime
├── docker-compose.yml          # Single service, two named volumes
├── main.go                     # Entry point: env config, routing, server startup
├── go.mod                      # Module: github.com/andresterba/dnd-music-manager
├── go.sum
├── internal/
│   ├── models/
│   │   └── models.go           # Shared Go structs (Campaign, Session, Track, Tag)
│   ├── db/
│   │   └── db.go               # SQLite: InitDB, migrations, all CRUD helpers
│   └── api/
│       └── handlers.go         # HTTP handlers, file upload, audio serving
├── uploads/                    # Audio files land here (bind-mounted in Docker)
└── web/
    ├── index.html              # Single HTML page, all markup + modals
    ├── style.css               # Dark D&D theme, fully custom CSS
    └── app.js                  # Vanilla JS: state machine, API client, audio engine
```

---

## Architecture Overview

```
Browser
  │  HTTP GET /           → static files from web/
  │  HTTP REST /api/...   → JSON API
  │  HTTP GET /api/audio/ → audio file (range-request capable)
  ▼
Go HTTP Server (net/http, port 8080)
  │
  ├── Static file server  → web/ directory
  │
  ├── API handlers        → internal/api/handlers.go
  │     └── calls         → internal/db/db.go
  │                            └── SQLite (modernc.org/sqlite, pure Go)
  │                                 DB file: $DATA_DIR/dnd-music.db
  │
  └── Audio file handler  → uploads/ directory
```

There is **no framework** on either side. The backend uses only the Go standard library plus a pure-Go SQLite driver. The frontend uses only the browser's native APIs (HTML5 Audio, Fetch, DOM).

---

## Data Model

### Hierarchy

```
Library Track  (owns the audio file, global)
      ↕  many-to-many via session_tracks
Campaign
 └── Session  (many per campaign)
      └── Session Playlist  (ordered references to library tracks)
           └── Tags  (many-to-many via track_tags, on library_tracks)
```

A **LibraryTrack** is the canonical record that owns the audio file. It is independent of any session. A **Session** holds an ordered playlist of references (`session_tracks`) to library tracks. The same library track can appear in many sessions. Deleting a session only removes its playlist entries — the library track and its file are unaffected. Deleting a library track removes the file and cascades to all session references.

### Go Structs (`internal/models/models.go`)

| Struct         | Key fields                                                              |
|----------------|-------------------------------------------------------------------------|
| `Campaign`     | `ID`, `Name`, `Description`, `CreatedAt`                               |
| `Session`      | `ID`, `CampaignID`, `Name`, `Description`, `CreatedAt`                 |
| `LibraryTrack` | `ID`, `Name`, `Filename`, `Tags []string`, `CreatedAt`                 |
| `SessionTrack` | `ID`, `SessionID`, `Position`, `LibraryTrack LibraryTrack`             |
| `Tag`          | `ID`, `Name`                                                            |

### SQLite Schema (`internal/db/db.go → migrate()`)

```sql
campaigns      (id, name, description, created_at)
sessions       (id, campaign_id → campaigns.id CASCADE, name, description, created_at)
library_tracks (id, name, filename, created_at)
tags           (id, name UNIQUE)
track_tags     (track_id → library_tracks.id CASCADE, tag_id → tags.id CASCADE)
session_tracks (id, session_id → sessions.id CASCADE,
                library_track_id → library_tracks.id CASCADE,
                position INTEGER,
                UNIQUE(session_id, library_track_id))
```

Foreign key cascades are enabled at connection time via `PRAGMA foreign_keys = ON`.

- Deleting a campaign cascades to its sessions and their `session_tracks` entries.
- Deleting a `library_track` cascades to all `session_tracks` referencing it (and removes the file from disk).
- Deleting a session only removes its `session_tracks` rows — library tracks are untouched.
- The `UNIQUE(session_id, library_track_id)` constraint prevents a track from appearing twice in the same session.

Tags are stored globally (deduplicated by name) and associated per library track through `track_tags`. When a track is updated, its tag associations are fully replaced.

---

## Backend

### Entry Point (`main.go`)

- Creates `uploads/` directory if absent.
- Reads `DATA_DIR` environment variable (defaults to `.`) to locate the SQLite file — this allows Docker to point it at a named volume.
- Reads `PUBLIC_PATH` and `BASE_PATH` environment variables for reverse-proxy sub-path support (see [Environment Variables](#environment-variables)).
- Initialises the DB via `db.InitDB()`.
- Registers all routes on `http.NewServeMux` (no third-party router).
- Wraps the mux with `withBasePath` (strips `BASE_PATH` prefix from incoming request paths).
- Wraps the static file server with `injectPublicPath` (rewrites `index.html` to inject `window.PUBLIC_PATH` so `app.js` prefixes all API calls correctly).
- Optionally wraps the root handler with `requestLogger` when `LOG_REQUESTS=true`.
- Serves `web/` as static files at `/`.
- Listens on `:8080`.

### Route Table

| Method | Path                                        | Handler                    | Description                                          |
|--------|---------------------------------------------|----------------------------|------------------------------------------------------|
| GET    | `/api/campaigns`                            | `HandleCampaigns`          | List all campaigns                                   |
| POST   | `/api/campaigns`                            | `HandleCampaigns`          | Create campaign                                      |
| PUT    | `/api/campaigns/{id}`                       | `HandleCampaigns`          | Update campaign                                      |
| DELETE | `/api/campaigns/{id}`                       | `HandleCampaigns`          | Delete campaign (cascades)                           |
| GET    | `/api/campaigns/{id}/sessions`              | `HandleCampaignSessions`   | List sessions for a campaign                         |
| POST   | `/api/campaigns/{id}/sessions`              | `HandleCampaignSessions`   | Create session                                       |
| PUT    | `/api/sessions/{id}`                        | `HandleSessions`           | Update session                                       |
| DELETE | `/api/sessions/{id}`                        | `HandleSessions`           | Delete session (cascades playlist only)              |
| GET    | `/api/sessions/{id}/tracks`                 | `HandleSessionTracks`      | List ordered session playlist (with tags)            |
| POST   | `/api/sessions/{id}/tracks`                 | `HandleSessionTracks`      | Add library track to session `{library_track_id}`    |
| PUT    | `/api/sessions/{id}/tracks/reorder`         | `HandleSessionTracks`      | Reorder playlist `{ids: [sessionTrackId, ...]}`      |
| DELETE | `/api/sessions/{sid}/tracks/{stid}`         | `HandleSessionTrackItem`   | Remove one entry from session playlist               |
| GET    | `/api/library`                              | `HandleLibrary`            | List all library tracks                              |
| POST   | `/api/library`                              | `HandleLibrary`            | Upload new track to library (multipart)              |
| PUT    | `/api/library/{id}`                         | `HandleLibrary`            | Update library track name + tags                     |
| DELETE | `/api/library/{id}`                         | `HandleLibrary`            | Delete library track + file + all session references |
| GET    | `/api/tags`                                 | `HandleTags`               | List all tags                                        |
| GET    | `/api/audio/{filename}`                     | `HandleAudio`              | Serve audio file (range requests)                    |

Route dispatch is done manually in `main.go` by splitting `r.URL.Path` into segments — no router library is used.

### File Upload (`handlers.go → uploadLibraryTrack()`)

- Accepts `multipart/form-data` with fields: `file`, `name`, `tags` (comma-separated string).
- Enforces a 100 MB limit via `http.MaxBytesReader`.
- Validates extension against an allowlist: `.mp3`, `.wav`, `.ogg`, `.flac`, `.m4a`.
- Saves the file to `uploads/` under a random 16-byte hex filename (preserving extension) to avoid collisions and not expose original filenames.
- Rolls back the file on any DB error.
- Always targets the library — sessions reference library tracks, they never own files directly.

### Audio Serving (`handlers.go → HandleAudio()`)

- Path: `GET /api/audio/{filename}`
- Uses `http.ServeContent` which handles `Range` headers, `ETag`, `Last-Modified`, and `304 Not Modified` automatically — essential for browser seeking.
- Sanitises the filename with `filepath.Base` to prevent directory traversal.
- Sets the correct `Content-Type` per extension (`audio/mpeg`, `audio/wav`, etc.).

### Database Layer (`internal/db/db.go`)

All functions take `*sql.DB` as their first argument (no ORM, no global state). Key functions:

| Function                   | Notes                                                                          |
|----------------------------|--------------------------------------------------------------------------------|
| `InitDB(path)`             | Opens DB, enables FK pragmas (`PRAGMA foreign_keys = ON`), runs `migrate()`   |
| `GetCampaigns`             | Returns `[]Campaign`, empty slice (never nil) on no rows                      |
| `GetLibraryTracks`         | Returns all library tracks with tags resolved                                  |
| `CreateLibraryTrack`       | INSERT into `library_tracks` + `setTagsForTrack`                              |
| `UpdateLibraryTrack`       | UPDATE name + full tag replacement                                             |
| `DeleteLibraryTrack`       | Returns filename for caller to `os.Remove`; CASCADE handles session_tracks     |
| `GetSessionTracks`         | JOIN `session_tracks` + `library_tracks`, ORDER BY position, resolves tags    |
| `AddTrackToSession`        | Checks duplicate via `UNIQUE` constraint, appends at `MAX(position)+1`        |
| `RemoveTrackFromSession`   | DELETE from `session_tracks` by session_track ID                               |
| `ReorderSessionTracks`     | Runs in a transaction; UPDATE position for each ID in the supplied order       |
| `ErrAlreadyInSession`      | Sentinel error returned by `AddTrackToSession` on duplicate                   |
| `setTagsForTrack`          | DELETE existing associations, upsert tags by name, INSERT into `track_tags`   |

SQLite datetime strings are parsed by `parseTime()` which tries multiple common formats.

---

## Frontend

The entire frontend is three files with **zero external dependencies** and **no build step**.

### `index.html`

Static markup only. Contains:
- The sidebar (`<aside>`) with two tabs — **Campaigns** and **Library** — and a campaign tree below.
- The main content area with three mutually-exclusive views:
  - **Welcome / empty state** — shown on first load.
  - **Session view** — session header, tag filter bar, ordered track list with drag handles.
  - **Library view** — library header with Upload button, tag filter bar, full track list.
- A persistent `<footer>` player bar with a progress bar, controls, crossfade, queue button, and layer slots.
- Six modal dialogs: Add/Edit Campaign, Add/Edit Session, Upload Track to Library, Edit Library Track, Add from Library (picker), Confirm Delete.
- A toast container for notifications.
- A single `<script src="app.js">` at the bottom.

### `style.css`

- Dark D&D theme with CSS custom properties defined in `:root`.
- Colour palette: deep navy backgrounds (`#1a1a2e`, `#16213e`, `#0f3460`), gold/amber accents (`#f5a623`), danger red (`#e94560`).
- Layout: CSS Grid for the three-panel layout (sidebar / main / player bar).
- Eight rotating tag colours (`--tag-color-0` … `--tag-color-7`) assigned consistently by tag name hash.
- Custom scrollbar styling, animated EQ bars for the playing indicator, spinner for loading states.
- Responsive breakpoints at 1024px (tablet drawer sidebar, two-row player bar) and 767px (phone).
- Fully self-contained — no external fonts or icon libraries.

### `app.js`

#### State

A single `state` object holds all runtime state:

```js
state = {
  campaigns, sessions,               // loaded sidebar data
  currentCampaign, currentSession,
  tracks,                            // SessionTrack[] for the current session
  activeTags,                        // Set — active filter tags for session view

  libraryTracks,                     // LibraryTrack[] — full library
  activeLibraryTags,                 // Set — active filter tags for library view
  libraryPickerAdded,                // Set of libraryTrack IDs already in current session

  queue, queueIndex,                 // playback queue [{track, sessionName}]
  isPlaying, isLooping,
  isCrossfade, crossfadeSecs,
  volume, isMuted, prevVolume,
  layeredTracks,                     // [{track, audio, volume}] simultaneous layers
  _crossfadeTimer, _fadingOut, _nextAudio,  // crossfade internals
  editingCampaignId, editingSessionId,      // ID of the item currently being edited in a modal
  editingSessionCampaignId,                 // campaign ID of the session being edited
  confirmCallback,                          // pending callback for the confirm-delete modal
  uploadTags, editTags,                     // tag input state
}
```

#### Audio Engine

- A single global `const audio = new Audio()` is the primary player.
- **Looping**: on `ended`, if `state.isLooping` is true, the same track restarts.
- **Queue advance**: on `ended` (no loop), `advanceQueue()` increments `queueIndex` and calls `playTrackFromQueue()`.
- **Crossfade**: `startCrossfade()` creates a second `Audio` object (`_nextAudio`), fades the main audio volume to 0 over `crossfadeSecs` using `setInterval`, then swaps it in as the main source.
- **Layering**: `addLayer()` creates an independent `Audio` object per layered track, appended to `state.layeredTracks`. Each layer has its own volume slider and stop button rendered in the player bar.
- **Progress bar**: driven by the existing `timeupdate` event — no polling. Clicking or touch-dragging the bar seeks the audio.

#### API Client

`apiFetch(method, path, body?)` is a thin wrapper around `fetch` that sets `Content-Type: application/json` for non-FormData bodies and throws on non-OK responses.

The `api` object exposes named methods for every endpoint:

```js
// Campaigns
api.getCampaigns()                            // GET    /api/campaigns
api.createCampaign(name, desc)               // POST   /api/campaigns
api.updateCampaign(id, name, desc)           // PUT    /api/campaigns/{id}
api.deleteCampaign(id)                       // DELETE /api/campaigns/{id}

// Sessions
api.getSessions(campaignId)                  // GET    /api/campaigns/{id}/sessions
api.createSession(campaignId, name, desc)    // POST   /api/campaigns/{id}/sessions
api.updateSession(id, name, desc)            // PUT    /api/sessions/{id}
api.deleteSession(id)                        // DELETE /api/sessions/{id}

// Session playlist
api.getSessionTracks(sessionId)              // GET    /api/sessions/{id}/tracks
api.addTrackToSession(sessionId, libId)      // POST   /api/sessions/{id}/tracks
api.removeTrackFromSession(sessionId, stId)  // DELETE /api/sessions/{sid}/tracks/{stid}
api.reorderSessionTracks(sessionId, ids)     // PUT    /api/sessions/{id}/tracks/reorder

// Library
api.getLibraryTracks()                       // GET    /api/library
api.uploadLibraryTrack(formData)             // POST   /api/library  (fetch; note: the upload modal uses XHR directly for progress tracking)
api.updateLibraryTrack(id, name, tags)       // PUT    /api/library/{id}
api.deleteLibraryTrack(id)                   // DELETE /api/library/{id}
```

#### Session Track List

- `state.tracks` holds `SessionTrack[]` objects (each wraps a `LibraryTrack` under `.track`).
- `renderTracks()` builds draggable cards. Each card has a `⠿⠿` drag handle.
- HTML5 Drag and Drop: `dragstart`/`drop` on cards call `sessionTrackMove(fromIdx, toIdx)`.
- `sessionTrackMove` reorders `state.tracks` locally for instant feedback, then calls `api.reorderSessionTracks` to persist. On failure it re-fetches to restore consistency.
- The **delete** button on a session card removes only the session reference (`removeTrackFromSession`). The library track is unaffected.
- The **edit** button opens the library track editor (edits propagate everywhere the track is used).

#### Library View

- Activated by clicking the **Library** tab in the sidebar.
- `loadLibrary()` fetches all library tracks and calls `renderLibrary()` + `renderLibraryTagFilterBar()`.
- `renderLibrary()` renders cards identical to session cards but with a **Delete from library** action instead of remove-from-session.
- The **Upload Track** button in the library header opens the upload modal; on success `loadLibrary()` is called to refresh.

#### Library Picker Modal

- Opened by **Add from Library** in the session header.
- `openLibraryPicker()` pre-computes `state.libraryPickerAdded` (IDs of tracks already in the session) and renders the full library.
- A live search input filters by name or tag client-side (no extra API call).
- Tracks already in the session show a disabled **✓ Added** button.
- Clicking **+ Add** calls `api.addTrackToSession` and immediately disables the button; the session track list is refreshed in the background.
- The server enforces the duplicate constraint (`UNIQUE(session_id, library_track_id)`) and returns HTTP 409 if violated; the frontend shows a toast with the error message.

#### UI Rendering

Rendering is imperative — functions build HTML strings and set `innerHTML`, or use `createElement` for complex event-bound elements. Event listeners for dynamic content are attached directly after building the DOM.

#### Tag Input

Both the upload and edit-track modals share a tag input component:
- Tags are stored in `state.uploadTags` / `state.editTags` arrays.
- `setupTagInput(context)` attaches keyboard listeners: `Enter` and `,` commit the current input as a new tag.
- `renderTagPills(context)` re-renders the pill list with remove buttons.

#### Toast Notifications

`showToast(message, type)` appends a temporary `<div class="toast">` to `#toast-container` (type: `success` / `error` / `info`), auto-removes after 3 seconds with a CSS fade-out.

---

## Docker & Deployment

### Dockerfile (multi-stage)

1. **Stage 1 (`builder`)** — `golang:1.26.1-alpine`: copies source, runs `go mod download`, builds a statically linked binary with `CGO_ENABLED=0 GOOS=linux`.
2. **Stage 2 (runtime)** — `alpine:3.23`: installs `ca-certificates` and `tzdata`, then copies only the binary and `web/` directory. Final image is small (~20 MB).

### docker-compose.yml

```yaml
volumes:
  uploads:   # audio files  → mounted at /app/uploads
  db:        # SQLite file   → mounted at /app/data
environment:
  DATA_DIR: /app/data
  TZ: Europe/Berlin
  # PUBLIC_PATH: /dnd      # sub-path the browser sees (reverse proxy)
  # BASE_PATH: /dnd        # prefix Go strips before routing (only if proxy doesn't strip it)
  # LOG_REQUESTS: "true"   # log every request with method, path, status, and duration
```

Both volumes are **named Docker volumes**, meaning they survive `docker compose down` and image rebuilds. To back up data: `docker volume inspect` to find the host path, or use `docker cp`.

### Environment Variables

| Variable       | Default | Purpose                                                                                          |
|----------------|---------|--------------------------------------------------------------------------------------------------|
| `DATA_DIR`     | `.`     | Directory where `dnd-music.db` is written                                                        |
| `TZ`           | —       | Timezone for log timestamps                                                                      |
| `PUBLIC_PATH`  | —       | Path prefix the **browser** uses (e.g. `/dnd`). Injected into `index.html` as `window.PUBLIC_PATH` so `app.js` prefixes all API calls. Set when a reverse proxy exposes the app at a sub-path. |
| `BASE_PATH`    | —       | Prefix that **Go strips** from incoming request paths before routing. Only needed when the reverse proxy does _not_ strip the prefix itself (e.g. nginx `proxy_pass` without `uri strip_prefix`). Leave empty when using Caddy `handle_path` or similar. |
| `LOG_REQUESTS` | —       | Set to `true` to log every request with method, path, status code, and duration.                |

The `uploads/` directory is always resolved relative to the process working directory (`/app` inside the container).

---

## Extending the Project

### Adding a new API endpoint

1. Add any new DB functions to `internal/db/db.go`.
2. Add the handler method to `internal/api/handlers.go` following the existing pattern (`corsHeaders`, method switch, `writeJSON`/`writeError`).
3. Register the route in `main.go` with `mux.HandleFunc`.

### Adding a new field to a model

1. Update the struct in `internal/models/models.go`.
2. Add the column to the relevant `CREATE TABLE` statement in `migrate()` — for existing databases, also write an `ALTER TABLE` migration (SQLite supports `ADD COLUMN`).
3. Update the relevant `db.go` query functions.
4. Update the frontend `app.js` rendering and/or modal forms.

### Switching to a different database

Replace `internal/db/db.go` — only `main.go` calls `db.InitDB()` and the handler layer calls the exported `db.*` functions. No other file knows about SQLite.

### Adding authentication

Wrap `mux` in a middleware handler that checks a session cookie or Bearer token before delegating to the existing routes. The single-user assumption is currently baked in (no `user_id` columns) but adding a users table and foreign keys would be straightforward.

### Adding a track to a session programmatically

```
POST /api/sessions/{id}/tracks
Content-Type: application/json
{ "library_track_id": 42 }
```

Returns HTTP 409 with `{"error": "this track is already in the session"}` on duplicate.

### Reordering a session playlist

```
PUT /api/sessions/{id}/tracks/reorder
Content-Type: application/json
{ "ids": [3, 1, 4, 1, 5] }   // session_track IDs in desired order
```

All IDs must belong to the given session. Positions are assigned 0, 1, 2, … in the order supplied.

---

## CI / CD

The repository ships with a GitHub Actions workflow (`.github/workflows/docker.yml`) that:

- **On every pull request** — builds the Docker image to verify the build succeeds (no push).
- **On push to `main`** — builds the image and publishes it to the **GitHub Container Registry** (`ghcr.io`) with two tags: `latest` and the short commit SHA.

To pull the published image:

```bash
docker pull ghcr.io/<owner>/dnd-music-manager:latest
```

No secrets need to be configured manually — the workflow uses the built-in `GITHUB_TOKEN`.

---

## Contributing

Bug reports, feature requests, and pull requests are welcome.

- Keep PRs focused; one concern per PR.
- Any change to the database schema **must** be implemented as a migration (add an `ALTER TABLE` statement in `migrate()` in `internal/db/db.go` alongside the `CREATE TABLE IF NOT EXISTS` baseline).
- There is no test suite yet — if you add a feature, please consider adding a test.

---

## License

[MIT](LICENSE)

---

## Dependencies

| Package                | Version  | Purpose                             |
|------------------------|----------|-------------------------------------|
| `modernc.org/sqlite`   | v1.29.6  | Pure-Go SQLite driver (no CGO)      |

All other imports are from the Go standard library. The frontend has no npm packages or CDN dependencies.
