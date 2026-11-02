package sift

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestIconSearchSharedVectors(t *testing.T) {
	data, err := os.ReadFile("testdata/icon-search.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		Catalog []Icon `json:"catalog"`
		Cases   []struct {
			Query string   `json:"query"`
			IDs   []string `json:"ids"`
		} `json:"cases"`
	}
	if err = json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, v := range vectors.Cases {
		t.Run(v.Query, func(t *testing.T) {
			got := []string{}
			for _, icon := range searchIcons(vectors.Catalog, v.Query) {
				got = append(got, icon.ID)
			}
			if !reflect.DeepEqual(got, v.IDs) {
				t.Fatalf("got %v, want %v", got, v.IDs)
			}
		})
	}
	if len(searchIcons(vectors.Catalog, strings.Repeat("x", 1000))) != 0 || len(searchIcons(nil, "gmail")) != 0 {
		t.Fatal("unbounded or empty catalog search")
	}
	if len(searchIcons([]Icon{{}}, "gmail")) != 0 {
		t.Fatal("empty metadata matched")
	}
	if len(searchIcons([]Icon{{ID: strings.Repeat("x", 40)}}, "xyx")) != 0 {
		t.Fatal("long metadata matched")
	}
}

func TestTablerCatalogOfflineAPIAndCLI(t *testing.T) {
	if len(Icons) != 6257 {
		t.Fatal("incomplete Tabler catalog", len(Icons))
	}
	seen := map[string]bool{}
	for _, icon := range Icons {
		if seen[icon.ID] || icon.ID == "" || icon.Symbol != "ti-"+icon.ID || icon.Name == "" || icon.Category == "" {
			t.Fatalf("invalid catalog entry: %+v", icon)
		}
		seen[icon.ID] = true
	}
	s := testService(t)
	h := s.routes()
	for query, want := range map[string]string{"slcak": "brand-slack", "gmial": "brand-gmail", "calender": "calendar", "circle%20check%20filled": "circle-check-filled"} {
		var icons []Icon
		if err := json.Unmarshal(routeRequest(t, h, "GET", "/api/icons?q="+query, nil, 200, false), &icons); err != nil {
			t.Fatal(err)
		}
		found := false
		for _, icon := range icons[:min(20, len(icons))] {
			if icon.ID == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("query %s did not rank %s near the top", query, want)
		}
	}
	server := httptest.NewServer(h)
	defer server.Close()
	client := &localClient{Connection: Connection{URL: server.URL, Token: "fixture"}, Actor: "icon-test"}
	data, err := client.request(context.Background(), "GET", "/api/icons?q=gmial", nil)
	if err != nil || !strings.Contains(string(data), `"id":"brand-gmail"`) {
		t.Fatalf("CLI catalog response: %s %v", data, err)
	}
	for _, id := range []string{"brand-slack", "brand-gmail", "circle-check-filled"} {
		task := mustTask(t, s.Store, Task{Title: "Catalog assignment " + id, Icon: id})
		if task.Icon != id {
			t.Fatal("task icon not persisted", task)
		}
	}
	if iconExists("task") || iconExists("https://example.com/upload.svg") {
		t.Fatal("non-Tabler icon accepted")
	}
	asset := routeRequest(t, h, "GET", "/tabler-icons.svg", nil, 200, false)
	if !strings.Contains(string(asset), `id="ti-brand-slack"`) || !strings.Contains(string(asset), `id="ti-brand-gmail"`) {
		t.Fatal("offline brand symbols missing")
	}
}
