package sift

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

func lockData(dir string) (func(), error) {
	f, err := os.OpenFile(filepath.Join(dir, "sift.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, fmt.Errorf("Sift is already running for this data directory")
	}
	return func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN); _ = f.Close() }, nil
}
