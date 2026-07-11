package models

import "time"

// Campaign represents a D&D campaign
type Campaign struct {
	ID          int       `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	CreatedAt   time.Time `json:"created_at"`
}

// Session represents a D&D session within a campaign
type Session struct {
	ID          int       `json:"id"`
	CampaignID  int       `json:"campaign_id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	CreatedAt   time.Time `json:"created_at"`
}

// LibraryTrack is a track in the central library.
// It owns the audio file and can be referenced by many sessions.
type LibraryTrack struct {
	ID               int       `json:"id"`
	Name             string    `json:"name"`
	Filename         string    `json:"filename"`
	OriginalFilename string    `json:"original_filename"`
	Tags             []string  `json:"tags"`
	CreatedAt        time.Time `json:"created_at"`
}

// SessionTrack is a reference from a session to a library track.
// It carries a position so the playlist within a session can be ordered.
type SessionTrack struct {
	ID           int          `json:"id"`
	SessionID    int          `json:"session_id"`
	Position     int          `json:"position"`
	LibraryTrack LibraryTrack `json:"track"`
}

// Tag represents a tag that can be applied to library tracks
type Tag struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}
