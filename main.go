package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/andresterba/dnd-music-manager/internal/api"
	"github.com/andresterba/dnd-music-manager/internal/db"
)

func main() {
	// Ensure the uploads directory exists
	uploadDir := "uploads"
	if err := os.MkdirAll(uploadDir, 0755); err != nil {
		log.Fatalf("Failed to create uploads directory: %v", err)
	}

	// Resolve the database path. DATA_DIR can be set via the environment
	// (e.g. by Docker) so the DB is written to a persistent volume.
	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = "."
	}
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		log.Fatalf("Failed to create data directory: %v", err)
	}
	dbPath := filepath.Join(dataDir, "dnd-music.db")

	// Initialize the database
	database, err := db.InitDB(dbPath)
	if err != nil {
		log.Fatalf("Failed to initialize database: %v", err)
	}
	defer database.Close()

	// ── Path configuration ────────────────────────────────────────────────────
	//
	// These two env vars solve the reverse-proxy sub-path problem:
	//
	//   PUBLIC_PATH  The path prefix the *browser* uses when building URLs,
	//                e.g. PUBLIC_PATH=/dnd means the browser calls /dnd/api/...
	//                This value is injected into the HTML as window.PUBLIC_PATH
	//                and used by app.js to prefix every API call.
	//                Set this when a reverse proxy exposes the app at a sub-path.
	//
	//   BASE_PATH    A prefix that Go itself must strip from incoming request
	//                paths before routing them.
	//                Only set this when the reverse proxy does NOT strip the
	//                prefix before forwarding (i.e. the full /dnd/api/... path
	//                arrives at Go).
	//                Leave empty when the proxy strips the prefix (e.g. Caddy's
	//                handle_path or uri strip_prefix) — in that case Go already
	//                receives the path without the prefix.
	//
	// Common configurations:
	//
	//   Caddy with handle_path /dnd/* (strips prefix):
	//     PUBLIC_PATH=/dnd   BASE_PATH=  (empty)
	//
	//   Nginx with proxy_pass http://app/dnd/ (passes prefix through):
	//     PUBLIC_PATH=/dnd   BASE_PATH=/dnd
	//
	//   No reverse proxy / running at root:
	//     PUBLIC_PATH=  (empty)   BASE_PATH=  (empty)

	publicPath := normalisePrefix(os.Getenv("PUBLIC_PATH"))
	basePath := normalisePrefix(os.Getenv("BASE_PATH"))

	// Create the API handler
	h := api.NewHandler(database, uploadDir)

	// mux handles all paths WITHOUT the base-path prefix.
	mux := http.NewServeMux()

	// ─── API Routes ───────────────────────────────────────────────────────────

	// Campaigns: /api/campaigns and /api/campaigns/{id}
	mux.HandleFunc("/api/campaigns/", func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimRight(r.URL.Path, "/")
		segments := strings.Split(strings.Trim(path, "/"), "/")

		// /api/campaigns/{id}/sessions
		if len(segments) == 4 && segments[3] == "sessions" {
			h.HandleCampaignSessions(w, r)
			return
		}

		h.HandleCampaigns(w, r)
	})

	mux.HandleFunc("/api/campaigns", func(w http.ResponseWriter, r *http.Request) {
		h.HandleCampaigns(w, r)
	})

	// Sessions: /api/sessions/{id} and /api/sessions/{id}/tracks[/reorder|/{stid}]
	mux.HandleFunc("/api/sessions/", func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimRight(r.URL.Path, "/")
		segments := strings.Split(strings.Trim(path, "/"), "/")

		// /api/sessions/{id}/tracks/reorder
		if len(segments) == 5 && segments[3] == "tracks" && segments[4] == "reorder" {
			h.HandleSessionTracks(w, r)
			return
		}

		// /api/sessions/{id}/tracks/{stid}  (delete a specific session track entry)
		if len(segments) == 5 && segments[3] == "tracks" && segments[4] != "" {
			h.HandleSessionTrackItem(w, r)
			return
		}

		// /api/sessions/{id}/tracks
		if len(segments) == 4 && segments[3] == "tracks" {
			h.HandleSessionTracks(w, r)
			return
		}

		// /api/sessions/{id}
		h.HandleSessions(w, r)
	})

	// Library: /api/library and /api/library/{id}
	mux.HandleFunc("/api/library/", func(w http.ResponseWriter, r *http.Request) {
		h.HandleLibrary(w, r)
	})

	mux.HandleFunc("/api/library", func(w http.ResponseWriter, r *http.Request) {
		h.HandleLibrary(w, r)
	})

	// Soundboard: /api/soundboard and /api/soundboard/{id}
	mux.HandleFunc("/api/soundboard/", func(w http.ResponseWriter, r *http.Request) {
		h.HandleSoundboard(w, r)
	})

	mux.HandleFunc("/api/soundboard", func(w http.ResponseWriter, r *http.Request) {
		h.HandleSoundboard(w, r)
	})

	// Tags: /api/tags
	mux.HandleFunc("/api/tags", func(w http.ResponseWriter, r *http.Request) {
		h.HandleTags(w, r)
	})

	// Audio: /api/audio/{filename}
	mux.HandleFunc("/api/audio/", func(w http.ResponseWriter, r *http.Request) {
		h.HandleAudio(w, r)
	})

	// ─── Static Files ─────────────────────────────────────────────────────────
	// Wrap the file server so index.html gets window.PUBLIC_PATH injected.
	webFS := http.FileServer(http.Dir("web"))
	mux.Handle("/", injectPublicPath(webFS, publicPath))

	// ─── Root handler ─────────────────────────────────────────────────────────
	// withBasePath optionally strips the BASE_PATH prefix before routing.
	// When BASE_PATH is "" this is a zero-cost passthrough.
	var rootHandler http.Handler = withBasePath(basePath, mux)

	// Optional request logging — enable with LOG_REQUESTS=true.
	if os.Getenv("LOG_REQUESTS") == "true" {
		rootHandler = requestLogger(rootHandler)
		log.Printf("Request logging enabled (LOG_REQUESTS=true)")
	}

	addr := ":8080"
	switch {
	case basePath != "" && publicPath != "":
		log.Printf("D&D Music Manager listening on http://localhost%s (public: %s/, go prefix: %s)", addr, publicPath, basePath)
	case publicPath != "":
		log.Printf("D&D Music Manager listening on http://localhost%s (public: %s/, proxy strips prefix)", addr, publicPath)
	default:
		log.Printf("D&D Music Manager listening on http://localhost%s", addr)
	}

	if err := http.ListenAndServe(addr, rootHandler); err != nil {
		log.Fatalf("Server error: %v", err)
	}
}

// normalisePrefix ensures a path prefix:
//   - starts with / (if non-empty)
//   - never ends with /
//   - treats "/" and "" as equivalent (returns "")
func normalisePrefix(s string) string {
	s = strings.TrimRight(s, "/")
	if s == "" {
		return ""
	}
	if !strings.HasPrefix(s, "/") {
		s = "/" + s
	}
	return s
}

// withBasePath strips basePath from every incoming request before passing it
// to next. When basePath is "" it is a zero-cost passthrough.
//
// Handling for a non-empty basePath (e.g. "/dnd"):
//
//	/dnd      → 301 redirect to /dnd/
//	/dnd/     → stripped to /,    forwarded to next
//	/dnd/foo  → stripped to /foo, forwarded to next
//	/other    → 404
func withBasePath(basePath string, next http.Handler) http.Handler {
	if basePath == "" {
		return next
	}

	prefixSlash := basePath + "/"

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path

		switch {
		case p == basePath:
			http.Redirect(w, r, prefixSlash, http.StatusMovedPermanently)

		case strings.HasPrefix(p, prefixSlash):
			r2 := r.Clone(r.Context())
			r2.URL.Path = p[len(basePath):]
			if r2.URL.RawPath != "" {
				if rp := r.URL.RawPath; strings.HasPrefix(rp, prefixSlash) {
					r2.URL.RawPath = rp[len(basePath):]
				}
			}
			next.ServeHTTP(w, r2)

		default:
			http.NotFound(w, r)
		}
	})
}

// injectPublicPath wraps the static file server and injects
// window.PUBLIC_PATH into index.html before </head>.
// All non-HTML responses (CSS, JS, audio) pass through unchanged.
func injectPublicPath(next http.Handler, publicPath string) http.Handler {
	snippet := fmt.Sprintf("<script>window.PUBLIC_PATH=%q;</script>", publicPath)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Only intercept requests that resolve to index.html:
		// the root path, or any path with no file extension.
		clean := strings.TrimRight(r.URL.Path, "/")
		isHTML := clean == "" || !strings.Contains(filepath.Base(clean), ".")

		if !isHTML {
			next.ServeHTTP(w, r)
			return
		}

		// Capture the response so we can rewrite the body.
		crw := &capturingResponseWriter{header: w.Header()}
		next.ServeHTTP(crw, r)

		body := crw.body
		ct := crw.header.Get("Content-Type")

		// Only rewrite successful HTML responses.
		if crw.status != http.StatusOK || !strings.HasPrefix(ct, "text/html") {
			w.WriteHeader(crw.status)
			w.Write(body) //nolint:errcheck
			return
		}

		injected := strings.Replace(string(body), "</head>", snippet+"\n</head>", 1)
		w.Header().Set("Content-Length", fmt.Sprintf("%d", len(injected)))
		w.WriteHeader(crw.status)
		fmt.Fprint(w, injected)
	})
}

// capturingResponseWriter buffers a handler's response for rewriting.
type capturingResponseWriter struct {
	header http.Header
	status int
	body   []byte
}

func (c *capturingResponseWriter) Header() http.Header { return c.header }

func (c *capturingResponseWriter) WriteHeader(status int) { c.status = status }

func (c *capturingResponseWriter) Write(b []byte) (int, error) {
	if c.status == 0 {
		c.status = http.StatusOK
	}
	c.body = append(c.body, b...)
	return len(b), nil
}

// requestLogger wraps a handler and logs every request with method, path,
// status code, and duration.
func requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		lrw := &loggingResponseWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(lrw, r)
		log.Printf("%s %s -> %d (%s)", r.Method, r.RequestURI, lrw.status, time.Since(start))
	})
}

// loggingResponseWriter captures the status code written by a handler.
type loggingResponseWriter struct {
	http.ResponseWriter
	status int
}

func (l *loggingResponseWriter) WriteHeader(status int) {
	l.status = status
	l.ResponseWriter.WriteHeader(status)
}
