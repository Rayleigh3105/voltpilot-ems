package installerwrite

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// MaxEntries bounds the on-disk audit log. A remote installer write is a rare,
// deliberate act (this is an EEPROM register), so fifty records cover years -
// and a bounded file can never grow into the data dir's problem.
const MaxEntries = 50

// FileName is the audit log inside the data dir. It SURVIVES A RESTART, which
// is the whole point: the question „who raised this plant's export limit, when,
// and from what" must still be answerable after the box reboots.
const FileName = "installer-write.json"

type logFile struct {
	Entries []Entry `json:"entries"`
}

// Log is the persistent audit trail. Safe for concurrent use.
type Log struct {
	mu   sync.Mutex
	path string
}

// NewLog opens (does not create) the log in dir. A missing file is not an
// error - it simply means nothing has been written yet.
func NewLog(dir string) (*Log, error) {
	if dir == "" {
		return nil, errors.New("installerwrite: empty data dir")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &Log{path: filepath.Join(dir, FileName)}, nil
}

// Append records one attempt, newest LAST on disk, and trims to MaxEntries.
//
// ⚠ It is written with the house tmp+rename discipline, so a power cut during
// the write leaves either the old log or the new one - never a truncated file
// that would lose the record of a write that already reached the inverter.
func (l *Log) Append(e Entry) error {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	f, err := l.load()
	if err != nil {
		return err
	}
	if e.At.IsZero() {
		e.At = time.Now().UTC()
	}
	f.Entries = append(f.Entries, e)
	if n := len(f.Entries); n > MaxEntries {
		f.Entries = f.Entries[n-MaxEntries:]
	}
	raw, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	tmp := l.path + ".tmp"
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, l.path)
}

// List returns the entries NEWEST FIRST (the order an operator reads them in).
// A missing or unreadable file yields an empty list: the surface then says
// „noch nichts geschrieben", which is the truth in both cases.
func (l *Log) List() []Entry {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	f, err := l.load()
	if err != nil {
		return nil
	}
	out := make([]Entry, 0, len(f.Entries))
	for i := len(f.Entries) - 1; i >= 0; i-- {
		out = append(out, f.Entries[i])
	}
	return out
}

func (l *Log) load() (logFile, error) {
	raw, err := os.ReadFile(l.path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return logFile{}, nil
		}
		return logFile{}, err
	}
	var f logFile
	if err := json.Unmarshal(raw, &f); err != nil {
		// A corrupt log must not block the write that is about to happen: the
		// record of THIS attempt matters more than the unreadable history, and
		// keeping it would mean never being able to append again.
		return logFile{}, nil
	}
	return f, nil
}
