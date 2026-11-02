package sift

import "testing"

func TestServePortConfiguration(t *testing.T) {
	t.Setenv("SIFT_PORT", "")
	for _, c := range []struct {
		flags map[string]string
		want  string
	}{
		{map[string]string{}, "127.0.0.1:57431"},
		{map[string]string{"port": "58432"}, "127.0.0.1:58432"},
		{map[string]string{"port": "0"}, "127.0.0.1:0"},
		{map[string]string{"address": "127.0.0.1:58433"}, "127.0.0.1:58433"},
	} {
		got, err := serveAddress(c.flags)
		if err != nil || got != c.want {
			t.Fatalf("%v: %s %v", c.flags, got, err)
		}
	}
	t.Setenv("SIFT_PORT", "58434")
	if got, e := serveAddress(map[string]string{}); e != nil || got != "127.0.0.1:58434" {
		t.Fatal(got, e)
	}
	if got, e := serveAddress(map[string]string{"port": "58435"}); e != nil || got != "127.0.0.1:58435" {
		t.Fatal(got, e)
	}
	for _, flags := range []map[string]string{{"port": "65536"}, {"port": "-1"}, {"port": "abc"}, {"port": "001"}, {"address": "0.0.0.0:57431"}, {"address": "localhost:57431"}, {"address": "127.0.0.1:80", "port": "57431"}} {
		if _, e := serveAddress(flags); e == nil {
			t.Fatal("accepted invalid config", flags)
		}
	}
}
