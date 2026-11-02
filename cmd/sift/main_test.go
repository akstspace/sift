package main

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestMainVersion(t *testing.T) {
	previous := os.Args
	os.Args = []string{"sift", "version"}
	t.Cleanup(func() { os.Args = previous })
	main()
}

func TestMainReportsFailureAndExits(t *testing.T) {
	if os.Getenv("SIFT_MAIN_ERROR_FIXTURE") == "1" {
		os.Args = []string{"sift", "serve", "--port", "not-a-port"}
		main()
		return
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestMainReportsFailureAndExits$")
	cmd.Env = append(os.Environ(), "SIFT_MAIN_ERROR_FIXTURE=1")
	output, err := cmd.CombinedOutput()
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 1 || !strings.Contains(string(output), "sift:") || !strings.Contains(string(output), "Port must") {
		t.Fatalf("expected a contextual CLI error and exit 1, got %v: %s", err, output)
	}
}
