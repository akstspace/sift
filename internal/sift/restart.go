package sift

import (
	"os"
	"syscall"
)

// serve, restartProcess and executablePath are seams for tests. In production,
// a restart re-executes the installed binary in place: same arguments,
// environment, and PID, so a login service keeps supervising the process
// across the update.
var serve = Serve

var executablePath = os.Executable

var restartProcess = func() error {
	exe, err := executablePath()
	if err != nil {
		return err
	}
	return syscall.Exec(exe, os.Args, os.Environ())
}

// reserveRestart claims the next restart while the workspace is idle, so no new
// run or maintenance begins before the process re-executes. A caller that holds
// maintenance itself (installing an update) passes holdingMaintenance.
func (s *Service) reserveRestart(holdingMaintenance bool) error {
	if s.restart == nil {
		return invalid("Restart is available only while Sift is serving")
	}
	s.runMu.Lock()
	defer s.runMu.Unlock()
	if (s.maintenance && !holdingMaintenance) || len(s.active) != 0 || s.chat.busy() {
		return conflict("Wait for running agents or maintenance to finish, then restart")
	}
	s.restarting = true
	return nil
}
