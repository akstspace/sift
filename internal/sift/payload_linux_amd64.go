//go:build linux && amd64

package sift

import "embed"

//go:embed payload/rustfs-linux-amd64
var payload embed.FS
