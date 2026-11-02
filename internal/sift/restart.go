package sift

import (
	"os"
	"syscall"
)

// serve and restartProcess are seams for tests. In production, a restart
// re-executes the installed binary in place: same arguments, environment, and
// PID, so a login service keeps supervising the process across the update.
var serve = Serve

var restartProcess = func() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	return syscall.Exec(exe, os.Args, os.Environ())
}
