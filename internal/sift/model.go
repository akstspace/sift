package sift

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

var Version = "0.1.7-dev"

type ChecklistItem struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Done  bool   `json:"done"`
}
type Task struct {
	ID           string          `json:"id"`
	Title        string          `json:"title"`
	Description  string          `json:"description"`
	Status       string          `json:"status"`
	Priority     string          `json:"priority"`
	Project      string          `json:"project"`
	Tags         []string        `json:"tags"`
	Icon         string          `json:"icon"`
	ParentID     string          `json:"parentId"`
	Today        bool            `json:"today"`
	DueDate      string          `json:"dueDate"`
	SnoozedUntil string          `json:"snoozedUntil"`
	Checklist    []ChecklistItem `json:"checklist"`
	Attachments  []string        `json:"attachments"`
	Source       string          `json:"source"`
	SourceKey    string          `json:"sourceKey"`
	MergedInto   string          `json:"mergedInto"`
	DeletedAt    string          `json:"deletedAt"`
	CompletedAt  string          `json:"completedAt"`
	ArchivedAt   string          `json:"archivedAt"`
	CreatedAt    string          `json:"createdAt"`
	UpdatedAt    string          `json:"updatedAt"`
	Actor        string          `json:"actor"`
	Revision     int             `json:"revision"`
}

func (t *Task) UnmarshalJSON(data []byte) error {
	type plain Task
	v := plain(*t)
	if err := json.Unmarshal(data, &v); err != nil {
		return err
	}
	// Old task records/history used UpdatedAt for completion. Freeze that
	// conservative baseline on read, before any subsequent edit can change it.
	if v.Status == "done" && v.CompletedAt == "" {
		if _, err := time.Parse(time.RFC3339Nano, v.UpdatedAt); err == nil {
			v.CompletedAt = v.UpdatedAt
		}
	}
	*t = Task(v)
	return nil
}

type Column struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
	Order int    `json:"order"`
}
type Entity struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Color    string `json:"color"`
	Archived bool   `json:"archived"`
	Icon     string `json:"icon"`
}
type Job struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Prompt    string `json:"prompt"`
	Directory string `json:"directory"`
	Provider  string `json:"provider"`
	Model     string `json:"model"`
	Thinking  string `json:"thinking"`
	// Schedules lists every trigger; the job runs at whichever comes first.
	Schedules      []JobSchedule `json:"schedules"`
	Timezone       string        `json:"timezone"`
	Enabled        bool          `json:"enabled"`
	TimeoutMinutes int           `json:"timeoutMinutes"`
	SessionID      string        `json:"sessionId"`
	NextRun        string        `json:"nextRun"`
	LastRun        string        `json:"lastRun"`
	Pending        bool          `json:"pending"`
	IncludeImages  bool          `json:"includeImages"`
	Revision       int           `json:"revision"`
}

// JobSchedule is one recurring trigger: daily or selected weekdays at a local
// HH:MM, a repeating interval such as 30m, or a five-field cron expression.
type JobSchedule struct {
	Type     string `json:"type"`
	Schedule string `json:"schedule"`
	Weekdays []int  `json:"weekdays,omitempty"`
}
type Run struct {
	ID        string `json:"id"`
	JobID     string `json:"jobId"`
	JobName   string `json:"jobName"`
	Status    string `json:"status"`
	StartedAt string `json:"startedAt"`
	EndedAt   string `json:"endedAt"`
	Summary   string `json:"summary"`
	Error     string `json:"error"`
	Model     string `json:"model"`
	SessionID string `json:"sessionId"`
	Job       Job    `json:"job"`
}

// RunEntry is one line of a run transcript: "text" and "thinking" from the
// model, "tool" when a tool starts (with its arguments) and "tool-result" when
// it ends (with its output), and "system" notices. Text stays a short summary
// so `sift runs watch` prints readable progress.
type RunEntry struct {
	Type       string          `json:"type"`
	Text       string          `json:"text"`
	At         string          `json:"at"`
	Tool       string          `json:"tool,omitempty"`
	Call       string          `json:"call,omitempty"`
	Args       json.RawMessage `json:"args,omitempty"`
	Output     string          `json:"output,omitempty"`
	Error      bool            `json:"error,omitempty"`
	DurationMs int64           `json:"durationMs,omitempty"`
}
type Attachment struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	MIME   string `json:"mime"`
	Size   int64  `json:"size"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	Hash   string `json:"hash"`
}
type Notification struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Message string `json:"message"`
	Read    bool   `json:"read"`
	At      string `json:"at"`
}
type Settings struct {
	ID                   string `json:"id"`
	Onboarded            bool   `json:"onboarded"`
	Timezone             string `json:"timezone"`
	Theme                string `json:"theme"`
	View                 string `json:"view"`
	Concurrency          int    `json:"concurrency"`
	TimeoutMinutes       int    `json:"timeoutMinutes"`
	CheckUpdates         bool   `json:"checkUpdates"`
	DesktopNotifications bool   `json:"desktopNotifications"`
	BackupRetention      int    `json:"backupRetention"`
	LogRetentionDays     int    `json:"logRetentionDays"`
	TrashRetentionDays   int    `json:"trashRetentionDays"`
	AutoArchiveDays      int    `json:"autoArchiveDays"`
	LastBackup           string `json:"lastBackup"`
	BackupError          string `json:"backupError"`
}

// Older workspaces and backups predate this preference. An explicit zero
// disables automatic archiving; an absent field gets the seven-day default.
func (s *Settings) UnmarshalJSON(data []byte) error {
	type plain Settings
	v := plain{AutoArchiveDays: 7}
	if err := json.Unmarshal(data, &v); err != nil {
		return err
	}
	*s = Settings(v)
	return nil
}

type Event struct {
	ID       int64           `json:"id"`
	Kind     string          `json:"kind"`
	EntityID string          `json:"entityId"`
	Actor    string          `json:"actor"`
	Reason   string          `json:"reason"`
	At       string          `json:"at"`
	Before   json.RawMessage `json:"before,omitempty"`
	After    json.RawMessage `json:"after,omitempty"`
	Group    string          `json:"group,omitempty"`
}
type Duplicate struct {
	ID      string   `json:"id"`
	Title   string   `json:"title"`
	Status  string   `json:"status"`
	Score   float64  `json:"score"`
	Reasons []string `json:"reasons"`
}
type APIError struct {
	Status  int
	Message string
	// Err keeps the underlying cause inspectable with errors.Is/As.
	Err error
}

func (e *APIError) Error() string { return e.Message }
func (e *APIError) Unwrap() error { return e.Err }
func invalid(format string, args ...any) error {
	return &APIError{Status: 400, Message: fmt.Sprintf(format, args...)}
}
func conflict(s string) error { return &APIError{Status: 409, Message: s} }

// upstream reports a failure in a service Sift depends on (GitHub, the
// network) as 502, so it isn't mistaken for a fault in Sift itself.
func upstream(cause error, format string, args ...any) error {
	return &APIError{Status: 502, Message: fmt.Sprintf(format, args...), Err: cause}
}
func newID(prefix string) string {
	b := make([]byte, 10)
	_, _ = rand.Read(b)
	return prefix + hex.EncodeToString(b)
}
func now() string          { return time.Now().UTC().Format(time.RFC3339Nano) }
func encode(v any) []byte  { b, _ := json.Marshal(v); return b }
func trim(s string) string { return strings.TrimSpace(s) }
