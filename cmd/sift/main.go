package main

import (
	"context"
	"fmt"
	"github.com/akstspace/sift/internal/sift"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := sift.CLI(ctx, os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "sift:", err)
		os.Exit(1)
	}
}
