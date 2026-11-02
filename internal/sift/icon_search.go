package sift

import (
	"sort"
	"strings"
)

// Keep the ranking contract in sync with web/src/icon-search.ts; shared vectors
// exercise both implementations. Input and edit-distance work are bounded.
func iconWords(value string) []string {
	return strings.FieldsFunc(strings.ToLower(value), func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9')
	})
}

func iconDistance(a, b string) int {
	d := make([][]int, len(a)+1)
	for i := range d {
		d[i] = make([]int, len(b)+1)
		d[i][0] = i
	}
	for j := range d[0] {
		d[0][j] = j
	}
	for i := 1; i <= len(a); i++ {
		for j := 1; j <= len(b); j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			d[i][j] = min(d[i-1][j]+1, d[i][j-1]+1, d[i-1][j-1]+cost)
			if i > 1 && j > 1 && a[i-1] == b[j-2] && a[i-2] == b[j-1] {
				d[i][j] = min(d[i][j], d[i-2][j-2]+1)
			}
		}
	}
	return d[len(a)][len(b)]
}

func iconWordScore(query, word string) int {
	if query == word {
		return 0
	}
	if strings.HasPrefix(word, query) {
		return 10 + min(len(word)-len(query), 9)
	}
	if strings.Contains(word, query) {
		return 20 + min(len(word)-len(query), 9)
	}
	best := 1000
	if len(query) >= 3 {
		pos := 0
		for i := range word {
			if pos < len(query) && query[pos] == word[i] {
				pos++
			}
		}
		if pos == len(query) {
			best = 40 + min(len(word)-len(query), 9)
		}
		if len(word) <= 32 && absInt(len(query)-len(word)) <= 2 {
			distance := iconDistance(query, word)
			limit := 1
			if len(query) >= 5 {
				limit = 2
			}
			if distance <= limit {
				best = min(best, 30+distance*10)
			}
		}
	}
	return best
}

func absInt(n int) int {
	return max(n, -n)
}

func searchIcons(catalog []Icon, query string) []Icon {
	// Normalize before bounding so Unicode separators behave like the UI.
	query = strings.Join(iconWords(query), " ")
	query = query[:min(len(query), 80)]
	tokens := iconWords(query)
	tokens = tokens[:min(len(tokens), 8)]
	type match struct {
		icon  Icon
		score int
	}
	matches := []match{}
	scores := map[string]int{}
	for _, icon := range catalog {
		words := iconWords(icon.ID + " " + icon.Name + " " + icon.Category + " " + strings.Join(icon.Aliases, " "))
		score := 0
		for _, token := range tokens {
			best := 1000
			for _, word := range words {
				key := token + ":" + word
				score, found := scores[key]
				if !found {
					score = iconWordScore(token, word)
					scores[key] = score
				}
				best = min(best, score)
			}
			score += best
		}
		if score < 1000 {
			matches = append(matches, match{icon, score})
		}
	}
	sort.SliceStable(matches, func(i, j int) bool { return matches[i].score < matches[j].score })
	out := make([]Icon, 0, len(matches))
	for _, match := range matches {
		out = append(out, match.icon)
	}
	return out
}
