//go:build linux && arm64

package sift

import "embed"

//go:embed payload/rustfs-linux-arm64
var payload embed.FS
