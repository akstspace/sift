//go:build darwin && arm64

package sift

import "embed"

//go:embed payload/rustfs-darwin-arm64
var payload embed.FS
