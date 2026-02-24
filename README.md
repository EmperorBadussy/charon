<p align="center">
  <img src="https://img.shields.io/badge/CHARON-v1.0.0-06B6D4?style=for-the-badge&labelColor=000000" alt="Version"/>
  <img src="https://img.shields.io/badge/Electron-33-0E7490?style=for-the-badge&logo=electron&logoColor=67E8F9&labelColor=000000" alt="Electron"/>
  <img src="https://img.shields.io/badge/Python-3.10+-22D3EE?style=for-the-badge&logo=python&logoColor=67E8F9&labelColor=000000" alt="Python"/>
  <img src="https://img.shields.io/badge/Platform-Windows-A5F3FC?style=for-the-badge&logo=windows&logoColor=67E8F9&labelColor=000000" alt="Platform"/>
  <img src="https://img.shields.io/badge/License-MIT-ECFEFF?style=for-the-badge&labelColor=000000" alt="License"/>
</p>

<h1 align="center">
  <br/>
  <code>[ CHARON ]</code>
  <br/>
  <sub>Catalog Harvester & Automated Ripper for Organized Navidrome</sub>
  <br/>
</h1>

<p align="center">
  <em>Your music doesn't belong to a corporation. Take it back.</em>
</p>

<p align="center">
  <strong>OLED-black. Styx Cyan. Digital rain. Tidal catalog → your Navidrome library in lossless. Zero compromise.</strong>
</p>

<p align="center">
  <a href="https://github.com/EmperorBadussy/aether">
    <img src="https://img.shields.io/badge/Companion-AETHER-7B2FBE?style=flat-square&labelColor=000000" alt="AETHER"/>
  </a>
</p>

---

<br/>

## `> WHAT IS THIS`

CHARON is a desktop application that rips music from Tidal and deposits it directly into your self-hosted Navidrome server. Search Tidal's entire catalog — artists, albums, tracks — queue what you want, pick your quality, and CHARON ferries it across the digital river into your personal library.

It's the companion app to [**AETHER**](https://github.com/EmperorBadussy/aether) — AETHER plays, CHARON harvests. Two halves of the same system.

Built on Electron with a Python bridge to [tiddl](https://github.com/oskvr37/tiddl) and [tidalapi](https://github.com/tamland/python-tidal). Every pixel matches the Styx Cyan design language — OLED black backgrounds with a monochromatic cyan/teal palette. A blurred digital rain canvas drifts behind frosted-glass panels.

<br/>

## `> FEATURES`

```
 SEARCH & BROWSE
  ├─ Full Tidal catalog search (artists, albums, tracks)
  ├─ Artist pages (discography, top tracks, bio)
  ├─ Album pages (track listing, metadata, artwork)
  ├─ Track detail views
  └─ Real-time search with result categorization

 DOWNLOAD ENGINE
  ├─ Quality tiers: Master (MQA/HiRes), Lossless (FLAC CD), High (AAC 320), Normal (AAC 96)
  ├─ Download queue with progress tracking
  ├─ Batch operations (queue entire albums/discographies)
  ├─ Automatic metadata & artwork embedding
  └─ Downloads directly to your Navidrome music directory

 NAVIDROME INTEGRATION
  ├─ Auto-detect running Navidrome instance
  ├─ Server management (start/stop/restart from within CHARON)
  ├─ One-click Navidrome installation wizard
  ├─ Trigger library scan after downloads complete
  ├─ Server health monitoring & stats
  └─ Configuration editor (TOML)

 AUTHENTICATION
  ├─ Tidal OAuth session (via tiddl)
  ├─ Auto-detect existing tiddl credentials
  ├─ Token refresh handling
  └─ Session status indicator

 INTERFACE
  ├─ OLED-optimized (true #000000 black)
  ├─ Monochromatic cyan palette (Styx Cyan — 12 shades)
  ├─ Blurred digital rain canvas background
  ├─ Glassmorphism panels with frosted-glass layering
  ├─ Frameless window with custom titlebar
  ├─ System tray integration
  └─ Responsive layout
```

<br/>

## `> HOW IT WORKS`

```
                    ┌──────────────────────────────────────────────┐
                    │               CHARON (Electron)              │
                    │                                              │
  ┌─────────┐      │  ┌────────────┐    IPC     ┌─────────────┐  │
  │  Tidal   │◄────┼──│  Python    │◄──────────►│  Electron   │  │
  │  API     │────►┼──│  Bridge    │   stdin/   │  Main       │  │
  │          │      │  │ (tidalapi) │   stdout   │  Process    │  │
  └─────────┘      │  └────────────┘    JSON     └──────┬──────┘  │
                    │                                    │         │
  ┌─────────┐      │  ┌────────────┐              ┌─────┴──────┐  │
  │  tiddl   │◄────┼──│  Download  │◄─────────────│  Renderer  │  │
  │  CLI     │────►┼──│  Queue     │   preload    │  (UI)      │  │
  │          │      │  └─────┬──────┘   bridge     └────────────┘  │
  └─────────┘      │        │                                      │
                    └────────┼──────────────────────────────────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │   Music Library  │──► Navidrome Scan
                    │   (FLAC/MQA)     │──► Your Library
                    └──────────────────┘
```

<br/>

## `> TECH STACK`

| Layer | Technology |
|-------|-----------|
| Runtime | Electron 33 |
| Renderer | Vanilla HTML/CSS/JS (single file) |
| Bridge | Python 3.10+ (JSON IPC over stdin/stdout) |
| Tidal Auth | tiddl (OAuth session management) |
| Tidal API | tidalapi (search, browse, metadata) |
| Download | tiddl CLI (MQA, FLAC, AAC support) |
| Server | Navidrome (Subsonic API) |
| Build | electron-builder (NSIS installer) |
| Design | Canvas 2D digital rain + glassmorphism |

<br/>

## `> ARCHITECTURE`

```
 CHARON/
  ├── main.js                # Electron main process — IPC, bridge, queue, Navidrome mgmt
  ├── preload.js             # Context bridge — 19 invoke channels, 3 send channels
  ├── ripper.html            # THE APP — search, browse, queue, settings, digital rain
  ├── index.html             # Website / landing page
  ├── python/
  │   └── charon_bridge.py   # Python bridge — tidalapi session, search, metadata
  ├── package.json           # Electron + builder config
  ├── icon.ico               # App icon (cyan on black)
  └── .gitignore             # Security-first exclusions
```

### IPC Architecture
```
  Renderer (ripper.html)
       │
       │  contextBridge (preload.js)
       │  19 invoke channels / 3 send channels
       ▼
  Main Process (main.js)
       │
       ├──► Window controls (minimize, maximize, close)
       ├──► Settings (get/set, persisted JSON)
       ├──► Download queue (add, remove, get, clear)
       ├──► Navidrome (scan, start, stop, install, config, stats)
       ├──► System (check-deps, open-folder, open-url)
       │
       └──► Python Bridge (stdin/stdout JSON)
              │
              ├──► search (query, type, limit)
              ├──► get_artist / get_album / get_track
              ├──► get_artist_albums / get_artist_top_tracks
              ├──► auth_status / auth_login
              └──► download (url, quality, path)
```

<br/>

## `> DESIGN SYSTEM`

CHARON follows the **Styx Cyan** design language — AETHER's twin, shifted from purple to cyan:

```css
/* Backgrounds — true OLED black */
--bg-void:      #000000
--bg-surface:   #060B0F
--bg-raised:    #0A1419
--bg-elevated:  #0C1820

/* Cyan scale — single hue, 8 stops */
--cyan-dim:     #0D2B36
--cyan-muted:   #0E4D64
--cyan-core:    #06B6D4
--cyan-bright:  #22D3EE
--cyan-vivid:   #67E8F9
--cyan-hot:     #A5F3FC
--cyan-white:   #ECFEFF

/* Digital rain canvas — blurred behind frosted-glass panels */
/* Mostly cyan characters with ~12% purple splashes */
/* filter: blur(2px), opacity: 0.5 */
```

Fonts: **Orbitron** (display) / **Rajdhani** (body) / **JetBrains Mono** (technical)

<br/>

## `> PREREQUISITES`

- [Node.js](https://nodejs.org/) 18+
- [Python](https://www.python.org/) 3.10+
- [tiddl](https://github.com/oskvr37/tiddl) — `pip install tiddl`
- [tidalapi](https://github.com/tamland/python-tidal) — `pip install tidalapi`
- A Tidal account (HiFi or HiFi Plus for lossless/MQA)
- [Navidrome](https://www.navidrome.org/) (optional — for auto-scan after download)

<br/>

## `> QUICK START`

### Install & Run
```bash
git clone https://github.com/EmperorBadussy/charon.git
cd charon
npm install
npm start
```

### Authenticate with Tidal
```bash
# First, authenticate tiddl with your Tidal account
tiddl
# Follow the OAuth prompts — this creates your session token
```

### Configure
1. Launch CHARON
2. Open Settings (gear icon)
3. Set your music download directory
4. Set your Navidrome server URL (if using)
5. Select default quality (Master / Lossless / High / Normal)
6. Start searching and ripping

### Build Installer
```bash
npm run dist
```
Outputs to `dist/` — NSIS installer for Windows x64.

<br/>

## `> QUALITY TIERS`

| Tier | Format | Bitrate | tiddl Flag |
|------|--------|---------|------------|
| **Master** | MQA / HiRes FLAC | Up to 9216 kbps | `master` |
| **Lossless** | FLAC 16-bit/44.1kHz | ~1411 kbps | `high` |
| **High** | AAC | 320 kbps | `normal` |
| **Normal** | AAC | 96 kbps | `low` |

<br/>

## `> COMPANION APP`

CHARON is one half of a two-app ecosystem:

| | AETHER | CHARON |
|---|--------|--------|
| **Purpose** | Play your library | Build your library |
| **Color** | Tron Purple | Styx Cyan |
| **Backend** | Navidrome (Subsonic API) | Tidal (tidalapi + tiddl) |
| **Repo** | [EmperorBadussy/aether](https://github.com/EmperorBadussy/aether) | You're here |
| **Website** | [aether-player.netlify.app](https://aether-player.netlify.app) | [charon-ripper.netlify.app](https://charon-ripper.netlify.app) |

**AETHER** plays. **CHARON** harvests. Your music, your server, your rules.

<br/>

## `> ROADMAP`

- [x] Tidal search (artists, albums, tracks)
- [x] Artist/album/track detail pages
- [x] Download queue with progress
- [x] Quality selection (Master/Lossless/High/Normal)
- [x] Navidrome server management (start/stop/restart/install)
- [x] Auto-scan Navidrome after downloads
- [x] Styx Cyan design system + digital rain
- [ ] macOS & Linux builds
- [ ] Playlist import (Tidal → local)
- [ ] Batch artist discography download
- [ ] Download history & duplicate detection
- [ ] Scheduled downloads
- [ ] Auto-updater

<br/>

## `> LICENSE`

MIT License. Do whatever you want. Credit appreciated but not required.

<br/>

---

<p align="center">
  <sub>Built for OLED. Engineered for digital river crossings. Designed from 2077.</sub>
</p>

<p align="center">
  <code>[ CHARON v1.0.0 ]</code>
</p>
