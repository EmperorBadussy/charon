"""
╔══════════════════════════════════════════════════════════════════╗
║  CHARON — Python Bridge                                          ║
║  JSON stdin/stdout IPC with Electron main process                ║
║                                                                    ║
║  Commands: search, get_artist, get_album, get_track,             ║
║            get_artist_albums, get_artist_top_tracks,             ║
║            auth_status, auth_login, download                     ║
╚══════════════════════════════════════════════════════════════════╝
"""

import sys
import json
import subprocess
import threading
import os
import re
import traceback

# Ensure unbuffered output
sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)

# ============ TIDALAPI SESSION ============
_session = None

def get_session():
    """Get or create tidalapi session using tiddl's stored credentials."""
    global _session
    if _session is not None:
        return _session

    try:
        import tidalapi
        _session = tidalapi.Session()

        # Try to load tiddl's stored auth token
        tiddl_config_path = os.path.expanduser("~/.tiddl/config.json")
        if os.path.exists(tiddl_config_path):
            with open(tiddl_config_path, "r") as f:
                config = json.load(f)
            token_type = config.get("token_type", "Bearer")
            access_token = config.get("access_token")
            refresh_token = config.get("refresh_token")

            if access_token:
                try:
                    _session.load_oauth_session(token_type, access_token, refresh_token)
                    if _session.check_login():
                        return _session
                except Exception:
                    pass

        # Try tidalapi's own session file
        session_file = os.path.expanduser("~/.tiddl/charon_session.json")
        if os.path.exists(session_file):
            try:
                _session.load_session(session_file)
                if _session.check_login():
                    return _session
            except Exception:
                pass

        # Not authenticated
        _session = tidalapi.Session()
        return _session

    except ImportError:
        sys.stderr.write("tidalapi not installed. Run: pip install tidalapi\n")
        return None


def is_authenticated():
    """Check if we have a valid Tidal session."""
    session = get_session()
    if session is None:
        return False
    try:
        return session.check_login()
    except Exception:
        return False


# ============ SEARCH ============
def handle_search(params):
    """Search Tidal catalog."""
    session = get_session()
    if not session or not is_authenticated():
        return {"status": "error", "error": "Not authenticated with Tidal"}

    query = params.get("query", "")
    search_type = params.get("type", "track")
    limit = params.get("limit", 50)

    if not query:
        return {"status": "error", "error": "No search query provided"}

    try:
        results = session.search(query, limit=limit)
        items = []

        if search_type == "track":
            for track in (results.tracks or [])[:limit]:
                items.append(format_track(track))
        elif search_type == "album":
            for album in (results.albums or [])[:limit]:
                items.append(format_album_summary(album))
        elif search_type == "artist":
            for artist in (results.artists or [])[:limit]:
                items.append(format_artist_summary(artist))

        return {"status": "ok", "data": {"results": items, "type": search_type}}

    except Exception as e:
        return {"status": "error", "error": str(e)}


# ============ GET DETAILS ============
def handle_get_artist(params):
    """Get artist details."""
    session = get_session()
    if not session or not is_authenticated():
        return {"status": "error", "error": "Not authenticated"}

    artist_id = params.get("artist_id")
    if not artist_id:
        return {"status": "error", "error": "No artist_id provided"}

    try:
        artist = session.artist(int(artist_id))
        return {"status": "ok", "data": format_artist_detail(artist)}
    except Exception as e:
        return {"status": "error", "error": str(e)}


def handle_get_album(params):
    """Get album details with track listing."""
    session = get_session()
    if not session or not is_authenticated():
        return {"status": "error", "error": "Not authenticated"}

    album_id = params.get("album_id")
    if not album_id:
        return {"status": "error", "error": "No album_id provided"}

    try:
        album = session.album(int(album_id))
        tracks = album.tracks()
        data = format_album_detail(album)
        data["tracks"] = [format_track(t) for t in tracks]
        return {"status": "ok", "data": data}
    except Exception as e:
        return {"status": "error", "error": str(e)}


def handle_get_track(params):
    """Get single track details."""
    session = get_session()
    if not session or not is_authenticated():
        return {"status": "error", "error": "Not authenticated"}

    track_id = params.get("track_id")
    if not track_id:
        return {"status": "error", "error": "No track_id provided"}

    try:
        track = session.track(int(track_id))
        return {"status": "ok", "data": format_track(track)}
    except Exception as e:
        return {"status": "error", "error": str(e)}


def handle_get_artist_albums(params):
    """Get artist's albums."""
    session = get_session()
    if not session or not is_authenticated():
        return {"status": "error", "error": "Not authenticated"}

    artist_id = params.get("artist_id")
    if not artist_id:
        return {"status": "error", "error": "No artist_id provided"}

    try:
        artist = session.artist(int(artist_id))
        albums = artist.get_albums()
        items = [format_album_summary(a) for a in albums]
        return {"status": "ok", "data": {"albums": items}}
    except Exception as e:
        return {"status": "error", "error": str(e)}


def handle_get_artist_top_tracks(params):
    """Get artist's top tracks."""
    session = get_session()
    if not session or not is_authenticated():
        return {"status": "error", "error": "Not authenticated"}

    artist_id = params.get("artist_id")
    if not artist_id:
        return {"status": "error", "error": "No artist_id provided"}

    try:
        artist = session.artist(int(artist_id))
        tracks = artist.get_top_tracks(limit=20)
        items = [format_track(t) for t in tracks]
        return {"status": "ok", "data": {"tracks": items}}
    except Exception as e:
        return {"status": "error", "error": str(e)}


# ============ AUTH ============
def handle_auth_status(params):
    """Check authentication status."""
    authed = is_authenticated()
    session = get_session()
    user_name = ""
    if authed and session:
        try:
            user = session.user
            user_name = getattr(user, "name", "") or getattr(user, "first_name", "") or ""
        except Exception:
            pass

    return {
        "status": "ok",
        "data": {
            "authenticated": authed,
            "user": user_name
        }
    }


def handle_auth_login(params):
    """Initiate OAuth login flow."""
    try:
        import tidalapi
        session = tidalapi.Session()
        login, future = session.login_oauth()

        # Return the auth URL — user needs to visit it
        return {
            "status": "ok",
            "data": {
                "auth_url": f"https://{login.verification_uri_complete}",
                "message": "Visit the URL to authenticate. Waiting..."
            }
        }
    except Exception as e:
        return {"status": "error", "error": str(e)}


# ============ DOWNLOAD ============
def handle_download(params, request_id):
    """Download via tiddl CLI and report progress."""
    url = params.get("url", "")
    quality = params.get("quality", "MAX")
    item_id = params.get("item_id", "")

    if not url:
        return {"status": "error", "error": "No URL provided"}

    # Build tiddl command
    cmd = ["tiddl", url, "-q", quality.lower()]

    # Get download directory from default or config
    download_dir = params.get("download_dir", os.path.expanduser("E:/Music"))
    if download_dir:
        cmd.extend(["-o", download_dir])

    try:
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env={**os.environ, "PYTHONUNBUFFERED": "1"}
        )

        last_progress = 0
        output_lines = []

        for line in process.stdout:
            line = line.strip()
            if not line:
                continue
            output_lines.append(line)

            # Parse progress from tiddl output
            progress_match = re.search(r"(\d+)%", line)
            if progress_match:
                progress = int(progress_match.group(1))
                if progress != last_progress:
                    last_progress = progress
                    # Send progress event
                    progress_msg = json.dumps({
                        "status": "progress",
                        "request_id": request_id,
                        "item_id": item_id,
                        "progress": progress,
                        "message": line
                    })
                    sys.stdout.write(progress_msg + "\n")
                    sys.stdout.flush()

        process.wait()

        if process.returncode == 0:
            # Try to find the downloaded file from output
            file_path = ""
            file_size = 0
            for out_line in output_lines:
                # tiddl typically prints the file path
                if os.sep in out_line or "/" in out_line:
                    potential_path = out_line.strip()
                    if os.path.exists(potential_path):
                        file_path = potential_path
                        file_size = os.path.getsize(potential_path)
                        break

            return {
                "status": "ok",
                "data": {
                    "file_path": file_path,
                    "file_size": file_size,
                    "output": "\n".join(output_lines[-10:])  # Last 10 lines
                }
            }
        else:
            return {
                "status": "error",
                "error": f"tiddl exited with code {process.returncode}",
                "output": "\n".join(output_lines[-10:])
            }

    except FileNotFoundError:
        return {"status": "error", "error": "tiddl not found. Install with: pip install tiddl"}
    except Exception as e:
        return {"status": "error", "error": str(e)}


# ============ FORMATTERS ============
def get_image_url(obj, size=480):
    """Safely get image URL from tidalapi object."""
    try:
        return obj.image(size)
    except Exception:
        try:
            return obj.image(320)
        except Exception:
            try:
                return obj.image(160)
            except Exception:
                return ""


def format_track(track):
    """Format a tidalapi Track object to dict."""
    artist_name = ""
    try:
        artist_name = track.artist.name if track.artist else ""
    except Exception:
        pass

    return {
        "id": str(track.id),
        "title": track.name or "",
        "name": track.name or "",
        "artist": artist_name,
        "artist_id": str(track.artist.id) if track.artist else "",
        "album": track.album.name if track.album else "",
        "album_id": str(track.album.id) if track.album else "",
        "duration": track.duration or 0,
        "track_number": track.track_num if hasattr(track, "track_num") else 0,
        "quality": getattr(track, "audio_quality", ""),
        "image_url": get_image_url(track.album) if track.album else "",
    }


def format_album_summary(album):
    """Format album for search results / grid."""
    artist_name = ""
    try:
        artist_name = album.artist.name if album.artist else ""
    except Exception:
        pass

    return {
        "id": str(album.id),
        "title": album.name or "",
        "artist": artist_name,
        "artist_id": str(album.artist.id) if album.artist else "",
        "year": getattr(album, "year", None) or (album.release_date.year if hasattr(album, "release_date") and album.release_date else None),
        "num_tracks": album.num_tracks if hasattr(album, "num_tracks") else 0,
        "quality": getattr(album, "audio_quality", ""),
        "image_url": get_image_url(album),
    }


def format_album_detail(album):
    """Format album with full details."""
    data = format_album_summary(album)
    data["duration"] = album.duration if hasattr(album, "duration") else 0
    return data


def format_artist_summary(artist):
    """Format artist for search results."""
    return {
        "id": str(artist.id),
        "name": artist.name or "",
        "image_url": get_image_url(artist),
    }


def format_artist_detail(artist):
    """Format artist with full details."""
    data = format_artist_summary(artist)
    try:
        data["bio"] = artist.get_bio() or ""
    except Exception:
        data["bio"] = ""
    return data


# ============ COMMAND ROUTER ============
HANDLERS = {
    "search": handle_search,
    "get_artist": handle_get_artist,
    "get_album": handle_get_album,
    "get_track": handle_get_track,
    "get_artist_albums": handle_get_artist_albums,
    "get_artist_top_tracks": handle_get_artist_top_tracks,
    "auth_status": handle_auth_status,
    "auth_login": handle_auth_login,
}


def process_command(line):
    """Parse and execute a JSON command from stdin."""
    try:
        cmd = json.loads(line)
    except json.JSONDecodeError as e:
        sys.stderr.write(f"JSON parse error: {e}\n")
        return

    action = cmd.get("action", "")
    params = cmd.get("params", {})
    request_id = cmd.get("request_id", "")

    # Download is special — it sends progress events
    if action == "download":
        result = handle_download(params, request_id)
    elif action in HANDLERS:
        result = HANDLERS[action](params)
    else:
        result = {"status": "error", "error": f"Unknown action: {action}"}

    result["request_id"] = request_id

    response = json.dumps(result)
    sys.stdout.write(response + "\n")
    sys.stdout.flush()


# ============ MAIN LOOP ============
def main():
    sys.stderr.write("CHARON bridge started. Listening for commands...\n")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            process_command(line)
        except Exception as e:
            sys.stderr.write(f"Unhandled error: {traceback.format_exc()}\n")
            # Try to send error response
            try:
                cmd = json.loads(line)
                request_id = cmd.get("request_id", "")
                error_resp = json.dumps({
                    "status": "error",
                    "error": str(e),
                    "request_id": request_id
                })
                sys.stdout.write(error_resp + "\n")
                sys.stdout.flush()
            except Exception:
                pass


if __name__ == "__main__":
    main()
