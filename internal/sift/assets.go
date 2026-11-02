package sift

import (
	"embed"
	"encoding/json"
)

//go:embed public
var frontend embed.FS

//go:embed skills/sift/SKILL.md
var skillText string

type Icon struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Category string   `json:"category"`
	Aliases  []string `json:"aliases"`
	Symbol   string   `json:"symbol"`
}

//go:embed icon-catalog.json
var iconCatalogJSON []byte

// The generated, pinned catalog is validated before release. No runtime network
// or uploaded SVG is involved; geometry lives in the same-origin bundled sprite.
var Icons = func() (icons []Icon) {
	_ = json.Unmarshal(iconCatalogJSON, &icons)
	return
}()

func iconExists(id string) bool {
	for _, i := range Icons {
		if i.ID == id {
			return true
		}
	}
	return false
}
