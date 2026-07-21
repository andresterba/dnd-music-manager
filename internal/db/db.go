package db

import (
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/andresterba/dnd-music-manager/internal/models"
	_ "modernc.org/sqlite"
)

// InitDB opens the SQLite database and runs migrations.
func InitDB(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}

	// SQLite allows only one writer at a time. A single connection means
	// database/sql serialises all operations before they reach SQLite,
	// preventing SQLITE_BUSY errors under concurrent request load.
	db.SetMaxOpenConns(1)

	pragmas := []string{
		"PRAGMA foreign_keys = ON",
		"PRAGMA journal_mode = WAL",
		"PRAGMA busy_timeout = 5000",
	}
	for _, p := range pragmas {
		if _, err := db.Exec(p); err != nil {
			return nil, fmt.Errorf("%s: %w", p, err)
		}
	}

	if err := migrate(db); err != nil {
		return nil, fmt.Errorf("migrate: %w", err)
	}

	return db, nil
}

func migrate(db *sql.DB) error {
	schema := `
	CREATE TABLE IF NOT EXISTS campaigns (
		id          INTEGER PRIMARY KEY AUTOINCREMENT,
		name        TEXT    NOT NULL,
		description TEXT,
		created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
	);

	CREATE TABLE IF NOT EXISTS sessions (
		id          INTEGER PRIMARY KEY AUTOINCREMENT,
		campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
		name        TEXT    NOT NULL,
		description TEXT,
		created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
	);

	-- Central audio library: owns the file, independent of any session.
	CREATE TABLE IF NOT EXISTS library_tracks (
		id                INTEGER PRIMARY KEY AUTOINCREMENT,
		name              TEXT    NOT NULL,
		filename          TEXT    NOT NULL,
		original_filename TEXT    NOT NULL DEFAULT '',
		created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
	);

	-- Tags are global and shared across library tracks.
	CREATE TABLE IF NOT EXISTS tags (
		id   INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL UNIQUE
	);

	CREATE TABLE IF NOT EXISTS track_tags (
		track_id INTEGER NOT NULL REFERENCES library_tracks(id) ON DELETE CASCADE,
		tag_id   INTEGER NOT NULL REFERENCES tags(id)           ON DELETE CASCADE,
		PRIMARY KEY (track_id, tag_id)
	);

	-- Session playlist: ordered references to library tracks.
	-- A library track can appear in many sessions, but only once per session.
	CREATE TABLE IF NOT EXISTS session_tracks (
		id               INTEGER PRIMARY KEY AUTOINCREMENT,
		session_id       INTEGER NOT NULL REFERENCES sessions(id)       ON DELETE CASCADE,
		library_track_id INTEGER NOT NULL REFERENCES library_tracks(id) ON DELETE CASCADE,
		position         INTEGER NOT NULL DEFAULT 0,
		UNIQUE (session_id, library_track_id)
	);

	-- Soundboard: short sound effects managed independently of the library.
	CREATE TABLE IF NOT EXISTS soundboard_sounds (
		id                INTEGER PRIMARY KEY AUTOINCREMENT,
		name              TEXT    NOT NULL,
		filename          TEXT    NOT NULL,
		original_filename TEXT    NOT NULL DEFAULT '',
		created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
	);
	`
	if _, err := db.Exec(schema); err != nil {
		return err
	}

	// Idempotent migration: add original_filename to databases created before this column existed.
	// SQLite has no "ADD COLUMN IF NOT EXISTS", so we run it unconditionally and ignore the
	// "duplicate column name" error that occurs on fresh databases (which already have it).
	db.Exec(`ALTER TABLE library_tracks ADD COLUMN original_filename TEXT NOT NULL DEFAULT ''`)

	return nil
}

// ─── Campaigns ───────────────────────────────────────────────────────────────

func GetCampaigns(db *sql.DB) ([]models.Campaign, error) {
	rows, err := db.Query(
		`SELECT id, name, COALESCE(description,''), created_at
		 FROM campaigns ORDER BY created_at ASC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []models.Campaign
	for rows.Next() {
		var c models.Campaign
		var ts string
		if err := rows.Scan(&c.ID, &c.Name, &c.Description, &ts); err != nil {
			return nil, err
		}
		c.CreatedAt = parseTime(ts)
		out = append(out, c)
	}
	if out == nil {
		out = []models.Campaign{}
	}
	return out, rows.Err()
}

func GetCampaignByID(db *sql.DB, id int) (models.Campaign, error) {
	var c models.Campaign
	var ts string
	err := db.QueryRow(
		`SELECT id, name, COALESCE(description,''), created_at FROM campaigns WHERE id = ?`, id,
	).Scan(&c.ID, &c.Name, &c.Description, &ts)
	if err != nil {
		return models.Campaign{}, err
	}
	c.CreatedAt = parseTime(ts)
	return c, nil
}

func CreateCampaign(db *sql.DB, name, description string) (models.Campaign, error) {
	res, err := db.Exec(`INSERT INTO campaigns (name, description) VALUES (?, ?)`, name, description)
	if err != nil {
		return models.Campaign{}, err
	}
	id, _ := res.LastInsertId()
	return GetCampaignByID(db, int(id))
}

func UpdateCampaign(db *sql.DB, id int, name, description string) (models.Campaign, error) {
	if _, err := db.Exec(
		`UPDATE campaigns SET name = ?, description = ? WHERE id = ?`, name, description, id,
	); err != nil {
		return models.Campaign{}, err
	}
	return GetCampaignByID(db, id)
}

func DeleteCampaign(db *sql.DB, id int) error {
	_, err := db.Exec(`DELETE FROM campaigns WHERE id = ?`, id)
	return err
}

// ─── Sessions ────────────────────────────────────────────────────────────────

func GetSessionsByCampaign(db *sql.DB, campaignID int) ([]models.Session, error) {
	rows, err := db.Query(
		`SELECT id, campaign_id, name, COALESCE(description,''), created_at
		 FROM sessions WHERE campaign_id = ? ORDER BY created_at ASC`,
		campaignID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []models.Session
	for rows.Next() {
		var s models.Session
		var ts string
		if err := rows.Scan(&s.ID, &s.CampaignID, &s.Name, &s.Description, &ts); err != nil {
			return nil, err
		}
		s.CreatedAt = parseTime(ts)
		out = append(out, s)
	}
	if out == nil {
		out = []models.Session{}
	}
	return out, rows.Err()
}

func GetSessionByID(db *sql.DB, id int) (models.Session, error) {
	var s models.Session
	var ts string
	err := db.QueryRow(
		`SELECT id, campaign_id, name, COALESCE(description,''), created_at FROM sessions WHERE id = ?`, id,
	).Scan(&s.ID, &s.CampaignID, &s.Name, &s.Description, &ts)
	if err != nil {
		return models.Session{}, err
	}
	s.CreatedAt = parseTime(ts)
	return s, nil
}

func CreateSession(db *sql.DB, campaignID int, name, description string) (models.Session, error) {
	res, err := db.Exec(
		`INSERT INTO sessions (campaign_id, name, description) VALUES (?, ?, ?)`,
		campaignID, name, description,
	)
	if err != nil {
		return models.Session{}, err
	}
	id, _ := res.LastInsertId()
	return GetSessionByID(db, int(id))
}

func UpdateSession(db *sql.DB, id int, name, description string) (models.Session, error) {
	if _, err := db.Exec(
		`UPDATE sessions SET name = ?, description = ? WHERE id = ?`, name, description, id,
	); err != nil {
		return models.Session{}, err
	}
	return GetSessionByID(db, id)
}

func DeleteSession(db *sql.DB, id int) error {
	_, err := db.Exec(`DELETE FROM sessions WHERE id = ?`, id)
	return err
}

// ─── Library Tracks ──────────────────────────────────────────────────────────

func GetLibraryTracks(db *sql.DB) ([]models.LibraryTrack, error) {
	rows, err := db.Query(
		`SELECT id, name, filename, original_filename, created_at FROM library_tracks ORDER BY name ASC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []models.LibraryTrack
	for rows.Next() {
		var t models.LibraryTrack
		var ts string
		if err := rows.Scan(&t.ID, &t.Name, &t.Filename, &t.OriginalFilename, &ts); err != nil {
			return nil, err
		}
		t.CreatedAt = parseTime(ts)
		t.Tags = []string{}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	for i, t := range out {
		tags, err := getTagsForTrack(db, t.ID)
		if err != nil {
			return nil, err
		}
		out[i].Tags = tags
	}

	if out == nil {
		out = []models.LibraryTrack{}
	}
	return out, nil
}

func GetLibraryTrackByID(db *sql.DB, id int) (models.LibraryTrack, error) {
	var t models.LibraryTrack
	var ts string
	err := db.QueryRow(
		`SELECT id, name, filename, original_filename, created_at FROM library_tracks WHERE id = ?`, id,
	).Scan(&t.ID, &t.Name, &t.Filename, &t.OriginalFilename, &ts)
	if err != nil {
		return models.LibraryTrack{}, err
	}
	t.CreatedAt = parseTime(ts)

	tags, err := getTagsForTrack(db, t.ID)
	if err != nil {
		return models.LibraryTrack{}, err
	}
	t.Tags = tags
	return t, nil
}

func CreateLibraryTrack(db *sql.DB, name, filename, originalFilename string, tags []string) (models.LibraryTrack, error) {
	res, err := db.Exec(
		`INSERT INTO library_tracks (name, filename, original_filename) VALUES (?, ?, ?)`, name, filename, originalFilename,
	)
	if err != nil {
		return models.LibraryTrack{}, err
	}
	id, _ := res.LastInsertId()

	if err := setTagsForTrack(db, int(id), tags); err != nil {
		return models.LibraryTrack{}, err
	}
	return GetLibraryTrackByID(db, int(id))
}

func UpdateLibraryTrack(db *sql.DB, id int, name string, tags []string) (models.LibraryTrack, error) {
	if _, err := db.Exec(
		`UPDATE library_tracks SET name = ? WHERE id = ?`, name, id,
	); err != nil {
		return models.LibraryTrack{}, err
	}
	if err := setTagsForTrack(db, id, tags); err != nil {
		return models.LibraryTrack{}, err
	}
	return GetLibraryTrackByID(db, id)
}

// DeleteLibraryTrack removes the library track (and all session references via CASCADE).
// It returns the filename so the caller can remove the file from disk.
func DeleteLibraryTrack(db *sql.DB, id int) (string, error) {
	var filename string
	if err := db.QueryRow(
		`SELECT filename FROM library_tracks WHERE id = ?`, id,
	).Scan(&filename); err != nil {
		return "", err
	}
	if _, err := db.Exec(`DELETE FROM library_tracks WHERE id = ?`, id); err != nil {
		return "", err
	}
	return filename, nil
}

// ─── Session Playlist (session_tracks) ───────────────────────────────────────

// GetSessionTracks returns the ordered playlist for a session.
func GetSessionTracks(db *sql.DB, sessionID int) ([]models.SessionTrack, error) {
	rows, err := db.Query(`
		SELECT st.id, st.session_id, st.position,
		       lt.id, lt.name, lt.filename, lt.created_at
		FROM session_tracks st
		JOIN library_tracks lt ON lt.id = st.library_track_id
		WHERE st.session_id = ?
		ORDER BY st.position ASC, st.id ASC`,
		sessionID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []models.SessionTrack
	for rows.Next() {
		var st models.SessionTrack
		var ts string
		if err := rows.Scan(
			&st.ID, &st.SessionID, &st.Position,
			&st.LibraryTrack.ID, &st.LibraryTrack.Name, &st.LibraryTrack.Filename, &ts,
		); err != nil {
			return nil, err
		}
		st.LibraryTrack.CreatedAt = parseTime(ts)
		st.LibraryTrack.Tags = []string{}
		out = append(out, st)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Resolve tags for each library track in the result set.
	for i, st := range out {
		tags, err := getTagsForTrack(db, st.LibraryTrack.ID)
		if err != nil {
			return nil, err
		}
		out[i].LibraryTrack.Tags = tags
	}

	if out == nil {
		out = []models.SessionTrack{}
	}
	return out, nil
}

// AddTrackToSession appends a library track to the end of a session's playlist.
// Returns a specific sentinel error if the track is already in the session.
func AddTrackToSession(db *sql.DB, sessionID, libraryTrackID int) (models.SessionTrack, error) {
	// Check for duplicate.
	var exists int
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM session_tracks WHERE session_id = ? AND library_track_id = ?`,
		sessionID, libraryTrackID,
	).Scan(&exists); err != nil {
		return models.SessionTrack{}, err
	}
	if exists > 0 {
		return models.SessionTrack{}, ErrAlreadyInSession
	}

	// Determine the next position.
	var maxPos sql.NullInt64
	if err := db.QueryRow(
		`SELECT MAX(position) FROM session_tracks WHERE session_id = ?`, sessionID,
	).Scan(&maxPos); err != nil {
		return models.SessionTrack{}, err
	}
	pos := 0
	if maxPos.Valid {
		pos = int(maxPos.Int64) + 1
	}

	res, err := db.Exec(
		`INSERT INTO session_tracks (session_id, library_track_id, position) VALUES (?, ?, ?)`,
		sessionID, libraryTrackID, pos,
	)
	if err != nil {
		return models.SessionTrack{}, err
	}
	id, _ := res.LastInsertId()
	return getSessionTrackByID(db, int(id))
}

// RemoveTrackFromSession removes a session_tracks row by its own ID.
func RemoveTrackFromSession(db *sql.DB, sessionTrackID int) error {
	_, err := db.Exec(`DELETE FROM session_tracks WHERE id = ?`, sessionTrackID)
	return err
}

// ReorderSessionTracks replaces the position values for a session with the
// supplied ordered slice of session_track IDs. All IDs must belong to the
// given session.
func ReorderSessionTracks(db *sql.DB, sessionID int, orderedIDs []int) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck

	stmt, err := tx.Prepare(
		`UPDATE session_tracks SET position = ? WHERE id = ? AND session_id = ?`,
	)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for pos, id := range orderedIDs {
		if _, err := stmt.Exec(pos, id, sessionID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func getSessionTrackByID(db *sql.DB, id int) (models.SessionTrack, error) {
	var st models.SessionTrack
	var ts string
	err := db.QueryRow(`
		SELECT st.id, st.session_id, st.position,
		       lt.id, lt.name, lt.filename, lt.created_at
		FROM session_tracks st
		JOIN library_tracks lt ON lt.id = st.library_track_id
		WHERE st.id = ?`, id,
	).Scan(
		&st.ID, &st.SessionID, &st.Position,
		&st.LibraryTrack.ID, &st.LibraryTrack.Name, &st.LibraryTrack.Filename, &ts,
	)
	if err != nil {
		return models.SessionTrack{}, err
	}
	st.LibraryTrack.CreatedAt = parseTime(ts)

	tags, err := getTagsForTrack(db, st.LibraryTrack.ID)
	if err != nil {
		return models.SessionTrack{}, err
	}
	st.LibraryTrack.Tags = tags
	return st, nil
}

// ErrAlreadyInSession is returned when a library track is added to a session
// it is already part of.
var ErrAlreadyInSession = fmt.Errorf("track is already in this session")

// ─── Tags ─────────────────────────────────────────────────────────────────────

func GetAllTags(db *sql.DB) ([]models.Tag, error) {
	rows, err := db.Query(`SELECT id, name FROM tags ORDER BY name ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []models.Tag
	for rows.Next() {
		var t models.Tag
		if err := rows.Scan(&t.ID, &t.Name); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	if out == nil {
		out = []models.Tag{}
	}
	return out, rows.Err()
}

// ─── Internal tag helpers ─────────────────────────────────────────────────────

func getTagsForTrack(db *sql.DB, trackID int) ([]string, error) {
	rows, err := db.Query(`
		SELECT t.name FROM tags t
		JOIN track_tags tt ON tt.tag_id = t.id
		WHERE tt.track_id = ?
		ORDER BY t.name ASC`,
		trackID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tags []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		tags = append(tags, name)
	}
	if tags == nil {
		tags = []string{}
	}
	return tags, rows.Err()
}

// setTagsForTrack fully replaces the tag associations for a library track.
func setTagsForTrack(db *sql.DB, trackID int, tags []string) error {
	if _, err := db.Exec(`DELETE FROM track_tags WHERE track_id = ?`, trackID); err != nil {
		return err
	}
	for _, raw := range tags {
		tag := strings.TrimSpace(raw)
		if tag == "" {
			continue
		}
		if _, err := db.Exec(
			`INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING`, tag,
		); err != nil {
			return err
		}
		var tagID int
		if err := db.QueryRow(`SELECT id FROM tags WHERE name = ?`, tag).Scan(&tagID); err != nil {
			return err
		}
		if _, err := db.Exec(
			`INSERT INTO track_tags (track_id, tag_id) VALUES (?, ?) ON CONFLICT DO NOTHING`,
			trackID, tagID,
		); err != nil {
			return err
		}
	}
	return nil
}

// ─── Soundboard ───────────────────────────────────────────────────────────────

func GetSoundboardSounds(db *sql.DB) ([]models.SoundboardSound, error) {
	rows, err := db.Query(
		`SELECT id, name, filename, original_filename, created_at FROM soundboard_sounds ORDER BY name ASC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []models.SoundboardSound
	for rows.Next() {
		var s models.SoundboardSound
		var ts string
		if err := rows.Scan(&s.ID, &s.Name, &s.Filename, &s.OriginalFilename, &ts); err != nil {
			return nil, err
		}
		s.CreatedAt = parseTime(ts)
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if out == nil {
		out = []models.SoundboardSound{}
	}
	return out, nil
}

func GetSoundboardSoundByID(db *sql.DB, id int) (models.SoundboardSound, error) {
	var s models.SoundboardSound
	var ts string
	err := db.QueryRow(
		`SELECT id, name, filename, original_filename, created_at FROM soundboard_sounds WHERE id = ?`, id,
	).Scan(&s.ID, &s.Name, &s.Filename, &s.OriginalFilename, &ts)
	if err != nil {
		return models.SoundboardSound{}, err
	}
	s.CreatedAt = parseTime(ts)
	return s, nil
}

func CreateSoundboardSound(db *sql.DB, name, filename, originalFilename string) (models.SoundboardSound, error) {
	res, err := db.Exec(
		`INSERT INTO soundboard_sounds (name, filename, original_filename) VALUES (?, ?, ?)`,
		name, filename, originalFilename,
	)
	if err != nil {
		return models.SoundboardSound{}, err
	}
	id, _ := res.LastInsertId()
	return GetSoundboardSoundByID(db, int(id))
}

func UpdateSoundboardSound(db *sql.DB, id int, name string) (models.SoundboardSound, error) {
	if _, err := db.Exec(
		`UPDATE soundboard_sounds SET name = ? WHERE id = ?`, name, id,
	); err != nil {
		return models.SoundboardSound{}, err
	}
	return GetSoundboardSoundByID(db, id)
}

// DeleteSoundboardSound removes the sound and returns its filename so the
// caller can remove the file from disk.
func DeleteSoundboardSound(db *sql.DB, id int) (string, error) {
	var filename string
	if err := db.QueryRow(
		`SELECT filename FROM soundboard_sounds WHERE id = ?`, id,
	).Scan(&filename); err != nil {
		return "", err
	}
	if _, err := db.Exec(`DELETE FROM soundboard_sounds WHERE id = ?`, id); err != nil {
		return "", err
	}
	return filename, nil
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

func parseTime(s string) time.Time {
	formats := []string{
		"2006-01-02 15:04:05",
		"2006-01-02T15:04:05Z",
		"2006-01-02T15:04:05",
		time.RFC3339,
	}
	for _, f := range formats {
		if t, err := time.Parse(f, s); err == nil {
			return t
		}
	}
	return time.Time{}
}
