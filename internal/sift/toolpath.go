package sift

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

// A login service starts Sift with a bare PATH (launchd hands out
// /usr/bin:/bin:/usr/sbin:/sbin), so Pi's "#!/usr/bin/env node" can't find
// node, and the agent can't find the person's own command-line tools. Pi and
// the commands Sift runs for it search the PATH the person's login shell sets
// up, then Sift's own, then the usual install folders.

// shellPath is the person's login-shell PATH, read once. Tests replace it so
// they never run the developer's own shell.
var shellPath = sync.OnceValue(func() []string {
	return loginShellPath(os.Getenv("SHELL"), 5*time.Second)
})

const pathMark = "__SIFT_PATH__"

// loginShellPath asks the person's shell, as a terminal would start it, for
// its PATH. Shell start-up files may print anything, may hang, or may leave
// background processes holding the output open, so the answer is read between
// markers and the whole process group is stopped at the deadline.
func loginShellPath(shell string, wait time.Duration) []string {
	if !filepath.IsAbs(shell) {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), wait)
	defer cancel()
	cmd := exec.CommandContext(ctx, shell, "-ilc", "printf '%s' "+pathMark+"; command printenv PATH; printf '%s' "+pathMark)
	cmd.Env = append(os.Environ(), "DISABLE_AUTO_UPDATE=true")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = time.Second
	out, _ := cmd.Output()
	_, rest, found := strings.Cut(string(out), pathMark)
	value, _, closed := strings.Cut(rest, pathMark)
	if !found || !closed {
		return nil
	}
	return filepath.SplitList(strings.TrimSpace(value))
}

// toolPath is the folder list Pi and its tools search, without repeats:
// the login shell's, Sift's own, any extra, then the usual install folders.
func toolPath(extra ...string) []string {
	home, _ := os.UserHomeDir()
	dirs := append(append(append([]string{}, shellPath()...), filepath.SplitList(os.Getenv("PATH"))...), extra...)
	if home != "" {
		dirs = append(dirs, filepath.Join(home, ".bun/bin"), filepath.Join(home, ".local/bin"))
	}
	dirs = append(dirs, "/opt/homebrew/bin", "/usr/local/bin")
	seen, out := map[string]bool{}, []string{}
	for _, dir := range dirs {
		if filepath.IsAbs(dir) && !seen[dir] {
			seen[dir] = true
			out = append(out, dir)
		}
	}
	return out
}

// findTool returns the first executable file named name in dirs.
func findTool(name string, dirs []string) string {
	for _, dir := range dirs {
		path := filepath.Join(dir, name)
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() && info.Mode()&0111 != 0 {
			return path
		}
	}
	return ""
}

// piCommand runs Pi with the search path above. The folder Pi is installed
// in comes before the usual install folders, since a package manager puts
// node beside the Pi it installs.
func piCommand(ctx context.Context, args ...string) *exec.Cmd {
	pi := PiPath()
	cmd := exec.CommandContext(ctx, pi, args...)
	env := []string{}
	for _, v := range os.Environ() {
		if !strings.HasPrefix(v, "PATH=") {
			env = append(env, v)
		}
	}
	extra := []string{}
	if filepath.IsAbs(pi) {
		extra = append(extra, filepath.Dir(pi))
	}
	cmd.Env = append(env, "PATH="+strings.Join(toolPath(extra...), string(os.PathListSeparator)))
	return cmd
}
