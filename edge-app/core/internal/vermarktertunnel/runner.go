package vermarktertunnel

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Runner starts, finds and stops the OpenVPN daemon. One implementation
// (exec + pidfile) serves the Mango and the container proof alike; the
// manager tests use a fake.
//
// The daemon is DELIBERATELY not a child of this process: openvpn.conf says
// `daemon` + `writepid`, so the tunnel keeps standing through a program
// update or crash (PS-D8), and a restarted program re-adopts it through the
// pidfile. The boot init (init.d/vp-vermarkter) starts the same daemon from
// the same configuration before the program is up.
type Runner interface {
	// Start launches the daemon with the written configuration. It returns
	// once the daemon forked (or with the start error).
	Start(konfig string) error
	// Alive reports whether the pidfile names a live OpenVPN process.
	Alive() bool
	// Stop terminates the daemon (TERM, then KILL) and waits until it is
	// gone. A missing daemon is not an error.
	Stop() error
}

// ExecRunner runs the real openvpn binary.
type ExecRunner struct {
	Bin   string // the openvpn executable (default "openvpn")
	Pfade Pfade
}

func (r *ExecRunner) bin() string {
	if r.Bin == "" {
		return "openvpn"
	}
	return r.Bin
}

func (r *ExecRunner) Start(konfig string) error {
	if err := os.MkdirAll(r.Pfade.RAM, 0o700); err != nil {
		return err
	}
	// --cd /: the config names every path absolutely; a working directory
	// inside a replaceable dir would pin it.
	cmd := exec.Command(r.bin(), "--cd", "/", "--config", konfig)
	out, err := cmd.CombinedOutput()
	if err != nil {
		// Never the config content, never key material - openvpn's own
		// startup lines name files and error classes only.
		return fmt.Errorf("openvpn start: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// pid reads the pidfile and verifies the process is (still) an openvpn - a
// recycled pid after a reboot must never be adopted, let alone killed.
func (r *ExecRunner) pid() (int, bool) {
	raw, err := os.ReadFile(r.Pfade.Pid())
	if err != nil {
		return 0, false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil || pid <= 1 {
		return 0, false
	}
	cmdline, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil {
		return 0, false
	}
	if !strings.Contains(strings.ReplaceAll(string(cmdline), "\x00", " "), "openvpn") {
		return 0, false
	}
	return pid, true
}

func (r *ExecRunner) Alive() bool {
	_, ok := r.pid()
	return ok
}

func (r *ExecRunner) Stop() error {
	pid, ok := r.pid()
	if !ok {
		return nil
	}
	_ = syscall.Kill(pid, syscall.SIGTERM)
	for i := 0; i < 50; i++ {
		if syscall.Kill(pid, 0) != nil {
			_ = os.Remove(r.Pfade.Pid())
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	_ = syscall.Kill(pid, syscall.SIGKILL)
	_ = os.Remove(r.Pfade.Pid())
	return nil
}
