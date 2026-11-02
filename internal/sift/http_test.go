package sift

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestFrontendRootAndRoutesDoNotRedirect(t *testing.T) {
	s := testService(t)
	for _, path := range []string{"/", "/index.html", "/tasks/route"} {
		r := httptest.NewRecorder()
		s.routes().ServeHTTP(r, httptest.NewRequest("GET", path, nil))
		if r.Code != 200 || !strings.Contains(r.Body.String(), "<html") {
			t.Fatalf("%s: HTTP %d %s", path, r.Code, r.Body.String())
		}
	}
}
