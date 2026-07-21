package api

import (
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/andresterba/dnd-music-manager/internal/db"
)

// Handler holds shared dependencies for all HTTP handlers.
type Handler struct {
	DB        *sql.DB
	UploadDir string
}

// NewHandler creates a new Handler.
func NewHandler(database *sql.DB, uploadDir string) *Handler {
	return &Handler{DB: database, UploadDir: uploadDir}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func pathSegments(r *http.Request) []string {
	return strings.Split(strings.Trim(r.URL.Path, "/"), "/")
}

func corsHeaders(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
}

func generateFilename(ext string) string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%d%s", time.Now().UnixNano(), ext)
	}
	return fmt.Sprintf("%x%s", b, ext)
}

func audioContentType(ext string) string {
	switch ext {
	case ".mp3":
		return "audio/mpeg"
	case ".wav":
		return "audio/wav"
	case ".ogg":
		return "audio/ogg"
	case ".flac":
		return "audio/flac"
	case ".m4a":
		return "audio/mp4"
	default:
		return "application/octet-stream"
	}
}

// ─── Campaigns ───────────────────────────────────────────────────────────────

// HandleCampaigns handles /api/campaigns and /api/campaigns/{id}
func (h *Handler) HandleCampaigns(w http.ResponseWriter, r *http.Request) {
	corsHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	segments := pathSegments(r)
	if len(segments) == 3 && segments[2] != "" {
		id, err := strconv.Atoi(segments[2])
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid campaign id")
			return
		}
		switch r.Method {
		case http.MethodPut:
			h.updateCampaign(w, r, id)
		case http.MethodDelete:
			h.deleteCampaign(w, r, id)
		default:
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		}
		return
	}

	switch r.Method {
	case http.MethodGet:
		campaigns, err := db.GetCampaigns(h.DB)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, campaigns)
	case http.MethodPost:
		h.createCampaign(w, r)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (h *Handler) createCampaign(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if strings.TrimSpace(body.Name) == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	campaign, err := db.CreateCampaign(h.DB, body.Name, body.Description)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, campaign)
}

func (h *Handler) updateCampaign(w http.ResponseWriter, r *http.Request, id int) {
	var body struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if strings.TrimSpace(body.Name) == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	campaign, err := db.UpdateCampaign(h.DB, id, body.Name, body.Description)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, campaign)
}

func (h *Handler) deleteCampaign(w http.ResponseWriter, _ *http.Request, id int) {
	if err := db.DeleteCampaign(h.DB, id); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"message": "deleted"})
}

// ─── Sessions ────────────────────────────────────────────────────────────────

// HandleCampaignSessions handles /api/campaigns/{id}/sessions
func (h *Handler) HandleCampaignSessions(w http.ResponseWriter, r *http.Request) {
	corsHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	segments := pathSegments(r)
	if len(segments) < 4 {
		writeError(w, http.StatusBadRequest, "invalid path")
		return
	}
	campaignID, err := strconv.Atoi(segments[2])
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid campaign id")
		return
	}

	switch r.Method {
	case http.MethodGet:
		sessions, err := db.GetSessionsByCampaign(h.DB, campaignID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, sessions)

	case http.MethodPost:
		var body struct {
			Name        string `json:"name"`
			Description string `json:"description"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		if strings.TrimSpace(body.Name) == "" {
			writeError(w, http.StatusBadRequest, "name is required")
			return
		}
		session, err := db.CreateSession(h.DB, campaignID, body.Name, body.Description)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, session)

	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// HandleSessions handles /api/sessions/{id} (PUT, DELETE)
func (h *Handler) HandleSessions(w http.ResponseWriter, r *http.Request) {
	corsHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	segments := pathSegments(r)
	if len(segments) < 3 {
		writeError(w, http.StatusBadRequest, "invalid path")
		return
	}
	id, err := strconv.Atoi(segments[2])
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid session id")
		return
	}

	switch r.Method {
	case http.MethodPut:
		var body struct {
			Name        string `json:"name"`
			Description string `json:"description"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		if strings.TrimSpace(body.Name) == "" {
			writeError(w, http.StatusBadRequest, "name is required")
			return
		}
		session, err := db.UpdateSession(h.DB, id, body.Name, body.Description)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, session)

	case http.MethodDelete:
		if err := db.DeleteSession(h.DB, id); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"message": "deleted"})

	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// ─── Session Playlist ─────────────────────────────────────────────────────────

// HandleSessionTracks handles:
//
//	GET  /api/sessions/{id}/tracks          → list ordered playlist
//	POST /api/sessions/{id}/tracks          → add library track to session  { library_track_id }
//	PUT  /api/sessions/{id}/tracks/reorder  → reorder  { ids: [sessionTrackID, ...] }
func (h *Handler) HandleSessionTracks(w http.ResponseWriter, r *http.Request) {
	corsHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// segments: ["api","sessions","{sessionID}","tracks"] or
	//           ["api","sessions","{sessionID}","tracks","reorder"]
	segments := pathSegments(r)
	if len(segments) < 4 {
		writeError(w, http.StatusBadRequest, "invalid path")
		return
	}
	sessionID, err := strconv.Atoi(segments[2])
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid session id")
		return
	}

	// Sub-route: /api/sessions/{id}/tracks/reorder
	if len(segments) == 5 && segments[4] == "reorder" {
		if r.Method != http.MethodPut {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		var body struct {
			IDs []int `json:"ids"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		if err := db.ReorderSessionTracks(h.DB, sessionID, body.IDs); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"message": "reordered"})
		return
	}

	switch r.Method {
	case http.MethodGet:
		tracks, err := db.GetSessionTracks(h.DB, sessionID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, tracks)

	case http.MethodPost:
		var body struct {
			LibraryTrackID int `json:"library_track_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		if body.LibraryTrackID == 0 {
			writeError(w, http.StatusBadRequest, "library_track_id is required")
			return
		}
		st, err := db.AddTrackToSession(h.DB, sessionID, body.LibraryTrackID)
		if err != nil {
			if errors.Is(err, db.ErrAlreadyInSession) {
				writeError(w, http.StatusConflict, "this track is already in the session")
				return
			}
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, st)

	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// HandleSessionTrackItem handles DELETE /api/sessions/{sid}/tracks/{stid}
func (h *Handler) HandleSessionTrackItem(w http.ResponseWriter, r *http.Request) {
	corsHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodDelete {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	// segments: ["api","sessions","{sid}","tracks","{stid}"]
	segments := pathSegments(r)
	if len(segments) < 5 {
		writeError(w, http.StatusBadRequest, "invalid path")
		return
	}
	stID, err := strconv.Atoi(segments[4])
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid session track id")
		return
	}
	if err := db.RemoveTrackFromSession(h.DB, stID); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"message": "removed"})
}

// ─── Library ──────────────────────────────────────────────────────────────────

// HandleLibrary handles /api/library and /api/library/{id}
func (h *Handler) HandleLibrary(w http.ResponseWriter, r *http.Request) {
	corsHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	segments := pathSegments(r)

	// /api/library/{id}
	if len(segments) == 3 && segments[2] != "" {
		id, err := strconv.Atoi(segments[2])
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid library track id")
			return
		}
		switch r.Method {
		case http.MethodPut:
			h.updateLibraryTrack(w, r, id)
		case http.MethodDelete:
			h.deleteLibraryTrack(w, r, id)
		default:
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		}
		return
	}

	// /api/library
	switch r.Method {
	case http.MethodGet:
		tracks, err := db.GetLibraryTracks(h.DB)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, tracks)

	case http.MethodPost:
		h.uploadLibraryTrack(w, r)

	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (h *Handler) uploadLibraryTrack(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	log.Printf("[upload] started — Content-Length: %d, Content-Type: %s",
		r.ContentLength, r.Header.Get("Content-Type"))

	r.Body = http.MaxBytesReader(w, r.Body, 100<<20)

	log.Printf("[upload] calling ParseMultipartForm (this reads the entire body)…")
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		log.Printf("[upload] ParseMultipartForm failed after %s: %v", time.Since(start), err)
		writeError(w, http.StatusBadRequest, "failed to parse multipart form: "+err.Error())
		return
	}
	log.Printf("[upload] ParseMultipartForm done in %s", time.Since(start))

	name := strings.TrimSpace(r.FormValue("name"))
	if name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}

	var tags []string
	if rawTags := strings.TrimSpace(r.FormValue("tags")); rawTags != "" {
		for _, t := range strings.Split(rawTags, ",") {
			if tag := strings.TrimSpace(t); tag != "" {
				tags = append(tags, tag)
			}
		}
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		log.Printf("[upload] FormFile failed: %v", err)
		writeError(w, http.StatusBadRequest, "file is required: "+err.Error())
		return
	}
	defer file.Close()
	log.Printf("[upload] got file: %q (%d bytes)", header.Filename, header.Size)

	ext := strings.ToLower(filepath.Ext(header.Filename))
	allowed := map[string]bool{
		".mp3": true, ".wav": true, ".ogg": true, ".flac": true, ".m4a": true,
	}
	if !allowed[ext] {
		writeError(w, http.StatusBadRequest, "unsupported audio format; allowed: mp3, wav, ogg, flac, m4a")
		return
	}

	filename := generateFilename(ext)
	destPath := filepath.Join(h.UploadDir, filename)

	log.Printf("[upload] creating destination file: %s", destPath)
	out, err := os.Create(destPath)
	if err != nil {
		log.Printf("[upload] os.Create failed: %v", err)
		writeError(w, http.StatusInternalServerError, "could not create destination file: "+err.Error())
		return
	}
	defer out.Close()

	log.Printf("[upload] copying file data to disk…")
	written, err := io.Copy(out, file)
	if err != nil {
		log.Printf("[upload] io.Copy failed after %d bytes: %v", written, err)
		_ = os.Remove(destPath)
		writeError(w, http.StatusInternalServerError, "failed to save file: "+err.Error())
		return
	}
	log.Printf("[upload] copied %d bytes in %s", written, time.Since(start))

	log.Printf("[upload] inserting into database…")
	track, err := db.CreateLibraryTrack(h.DB, name, filename, header.Filename, tags)
	if err != nil {
		log.Printf("[upload] database error: %v", err)
		_ = os.Remove(destPath)
		writeError(w, http.StatusInternalServerError, "database error: "+err.Error())
		return
	}

	log.Printf("[upload] done in %s — track id: %d", time.Since(start), track.ID)
	writeJSON(w, http.StatusOK, track)
}

func (h *Handler) updateLibraryTrack(w http.ResponseWriter, r *http.Request, id int) {
	var body struct {
		Name string   `json:"name"`
		Tags []string `json:"tags"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if strings.TrimSpace(body.Name) == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	if body.Tags == nil {
		body.Tags = []string{}
	}
	track, err := db.UpdateLibraryTrack(h.DB, id, body.Name, body.Tags)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, track)
}

func (h *Handler) deleteLibraryTrack(w http.ResponseWriter, _ *http.Request, id int) {
	filename, err := db.DeleteLibraryTrack(h.DB, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = os.Remove(filepath.Join(h.UploadDir, filename))
	writeJSON(w, http.StatusOK, map[string]string{"message": "deleted"})
}

// ─── Soundboard ───────────────────────────────────────────────────────────────

// HandleSoundboard handles /api/soundboard and /api/soundboard/{id}
func (h *Handler) HandleSoundboard(w http.ResponseWriter, r *http.Request) {
	corsHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	segments := pathSegments(r)

	// /api/soundboard/{id}
	if len(segments) == 3 && segments[2] != "" {
		id, err := strconv.Atoi(segments[2])
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid sound id")
			return
		}
		switch r.Method {
		case http.MethodPut:
			h.updateSoundboardSound(w, r, id)
		case http.MethodDelete:
			h.deleteSoundboardSound(w, r, id)
		default:
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		}
		return
	}

	// /api/soundboard
	switch r.Method {
	case http.MethodGet:
		sounds, err := db.GetSoundboardSounds(h.DB)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, sounds)

	case http.MethodPost:
		h.uploadSoundboardSound(w, r)

	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (h *Handler) uploadSoundboardSound(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 100<<20)

	if err := r.ParseMultipartForm(32 << 20); err != nil {
		writeError(w, http.StatusBadRequest, "failed to parse multipart form: "+err.Error())
		return
	}

	name := strings.TrimSpace(r.FormValue("name"))
	if name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "file is required: "+err.Error())
		return
	}
	defer file.Close()

	ext := strings.ToLower(filepath.Ext(header.Filename))
	allowed := map[string]bool{
		".mp3": true, ".wav": true, ".ogg": true, ".flac": true, ".m4a": true,
	}
	if !allowed[ext] {
		writeError(w, http.StatusBadRequest, "unsupported audio format; allowed: mp3, wav, ogg, flac, m4a")
		return
	}

	filename := generateFilename(ext)
	destPath := filepath.Join(h.UploadDir, filename)

	out, err := os.Create(destPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not create destination file: "+err.Error())
		return
	}
	defer out.Close()

	if _, err := io.Copy(out, file); err != nil {
		_ = os.Remove(destPath)
		writeError(w, http.StatusInternalServerError, "failed to save file: "+err.Error())
		return
	}

	sound, err := db.CreateSoundboardSound(h.DB, name, filename, header.Filename)
	if err != nil {
		_ = os.Remove(destPath)
		writeError(w, http.StatusInternalServerError, "database error: "+err.Error())
		return
	}

	writeJSON(w, http.StatusOK, sound)
}

func (h *Handler) updateSoundboardSound(w http.ResponseWriter, r *http.Request, id int) {
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if strings.TrimSpace(body.Name) == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	sound, err := db.UpdateSoundboardSound(h.DB, id, body.Name)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, sound)
}

func (h *Handler) deleteSoundboardSound(w http.ResponseWriter, _ *http.Request, id int) {
	filename, err := db.DeleteSoundboardSound(h.DB, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = os.Remove(filepath.Join(h.UploadDir, filename))
	writeJSON(w, http.StatusOK, map[string]string{"message": "deleted"})
}

// ─── Tags ─────────────────────────────────────────────────────────────────────

func (h *Handler) HandleTags(w http.ResponseWriter, r *http.Request) {
	corsHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	tags, err := db.GetAllTags(h.DB)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, tags)
}

// ─── Audio ────────────────────────────────────────────────────────────────────

func (h *Handler) HandleAudio(w http.ResponseWriter, r *http.Request) {
	corsHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	segments := pathSegments(r)
	if len(segments) < 3 || segments[2] == "" {
		writeError(w, http.StatusBadRequest, "filename required")
		return
	}

	filename := filepath.Base(segments[2])
	filePath := filepath.Join(h.UploadDir, filename)

	f, err := os.Open(filePath)
	if err != nil {
		if os.IsNotExist(err) {
			writeError(w, http.StatusNotFound, "file not found")
		} else {
			writeError(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	defer f.Close()

	stat, err := f.Stat()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	ext := strings.ToLower(filepath.Ext(filename))
	w.Header().Set("Content-Type", audioContentType(ext))
	w.Header().Set("Accept-Ranges", "bytes")
	http.ServeContent(w, r, filename, stat.ModTime(), f)
}
