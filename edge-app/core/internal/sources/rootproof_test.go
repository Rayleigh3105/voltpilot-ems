package sources

// A persist failure must be forced by a TYPE collision, never by file
// permissions.
//
// The edge release gate runs as root on the Forgejo runner, and root bypasses
// the DAC write check: `chmod 0500` on a directory does not stop root from
// creating a file in it. A test that makes something unwritable and then
// asserts "the write failed" therefore passes on every developer machine and
// FAILS in CI - the write simply succeeds there. That is exactly how tag
// edge-2026.08.21 red the gate (agent.TestDeleteSourceRollsBackOnPersistFailure,
// the first tagged run in which the Go core step ever got past the localbus
// deadlock of #522 and actually reached this test).
//
// The two tests below are the two halves of the fix: the first pins the
// mechanism that replaces it, the second stops the permission trick from
// coming back anywhere in this module.

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// The scratch path IS what Save writes, and a directory in its place makes the
// write fail for a reason no privilege can override. Proven from both sides so
// the exported accessor can never drift away from Save's own tmp name.
func TestSaveFailsWhenTheScratchPathIsADirectory(t *testing.T) {
	dir := t.TempDir()
	st, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	list := []Source{{ID: "src-1", Role: RoleErzeuger}}
	if err := st.Save(list); err != nil {
		t.Fatalf("first Save: %v", err)
	}

	tmp := st.TempPath()
	if filepath.Dir(tmp) != dir {
		t.Fatalf("scratch path %q is not inside the store dir %q", tmp, dir)
	}
	if err := os.Mkdir(tmp, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := st.Save([]Source{}); err == nil {
		t.Fatal("Save must fail while a directory occupies its scratch path")
	}

	// The failure is a refusal, not a corruption: the previously persisted
	// list is still there and still readable (what the agent's rollback
	// assumes when it puts the source back in memory).
	got, ok, err := st.Load()
	if err != nil || !ok || len(got) != 1 || got[0].ID != "src-1" {
		t.Fatalf("stored list damaged by the failed Save: %v %v %+v", err, ok, got)
	}

	if err := os.Remove(tmp); err != nil {
		t.Fatal(err)
	}
	if err := st.Save([]Source{}); err != nil {
		t.Fatalf("Save after the scratch path is free again: %v", err)
	}
}

// os.Chmod / os.Mkdir* with the owner write bit CLEARED is the signature of the
// permission trick. Nothing in this module may use it: under root it is a no-op
// and the assertion that depends on it turns a sound tree red.
func TestNoGoTestForcesAFailureWithFilePermissions(t *testing.T) {
	// The mode literal of a chmod/mkdir call. Written WITHOUT a sample call
	// in the comment on purpose: this file is walked too, and a literal
	// example would make the guard flag itself.
	call := regexp.MustCompile(`os\.(?:Chmod|Mkdir|MkdirAll)\([^()]*?0o?([0-7]{3,4})\)`)

	var offenders []string
	scanned := 0
	root := filepath.Join("..", "..") // the edge-app/core module
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(d.Name(), "_test.go") {
			return nil
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		scanned++
		for _, m := range call.FindAllStringSubmatch(string(raw), -1) {
			mode, convErr := strconv.ParseInt(m[1], 8, 32)
			if convErr != nil {
				continue
			}
			if mode&0o200 == 0 { // owner may not write
				offenders = append(offenders, path+": "+m[0])
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	// A guard that walked nothing would pass forever. The module carries well
	// over a hundred test files; anything near zero means the relative root
	// moved and the guard is no longer guarding.
	if scanned < 50 {
		t.Fatalf("only %d *_test.go files scanned below %q - the walk root is wrong", scanned, root)
	}
	if len(offenders) > 0 {
		t.Fatalf("tests must not make a path unwritable to force a failure - "+
			"the CI runner is root and ignores the write bit. Use a type "+
			"collision instead (a directory where a file is written, or a file "+
			"where a directory is created); see sources.Store.TempPath.\n  %s",
			strings.Join(offenders, "\n  "))
	}
}
