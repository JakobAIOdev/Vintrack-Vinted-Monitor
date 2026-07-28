package proxy

import (
	"testing"
)

func TestParseProxyLine_HTTPFormat(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{"http with auth", "http://user:pass@1.2.3.4:8080", "http://user:pass@1.2.3.4:8080"},
		{"https with auth", "https://user:pass@proxy.example.com:443", "https://user:pass@proxy.example.com:443"},
		{"socks5 with auth", "socks5://user:pass@10.0.0.1:1080", "socks5://user:pass@10.0.0.1:1080"},
		{"http no auth", "http://1.2.3.4:8080", "http://1.2.3.4:8080"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := parseProxyLine(tt.input)
			if result != tt.expected {
				t.Errorf("parseProxyLine(%q) = %q, want %q", tt.input, result, tt.expected)
			}
		})
	}
}

func TestParseProxyLine_HostPortUserPassFormat(t *testing.T) {
	result := parseProxyLine("1.2.3.4:8080:user:pass")
	expected := "http://user:pass@1.2.3.4:8080"
	if result != expected {
		t.Errorf("parseProxyLine(host:port:user:pass) = %q, want %q", result, expected)
	}
}

func TestParseProxyLine_HostPortFormat(t *testing.T) {
	result := parseProxyLine("1.2.3.4:8080")
	expected := "http://1.2.3.4:8080"
	if result != expected {
		t.Errorf("parseProxyLine(host:port) = %q, want %q", result, expected)
	}
}

func TestParseProxyLine_Invalid(t *testing.T) {
	invalid := []string{
		"",
		"   ",
		"not-a-proxy",
		"ftp://invalid:8080",
		"http://noport",
	}
	for _, input := range invalid {
		t.Run(input, func(t *testing.T) {
			result := parseProxyLine(input)
			if result != "" {
				t.Errorf("parseProxyLine(%q) = %q, want empty string", input, result)
			}
		})
	}
}

func TestValidateProxy(t *testing.T) {
	tests := []struct {
		name  string
		input string
		valid bool
	}{
		{"valid http", "http://1.2.3.4:8080", true},
		{"valid socks5", "socks5://user:pass@proxy.com:1080", true},
		{"missing port", "http://1.2.3.4", false},
		{"missing host", "http://:8080", false},
		{"invalid scheme", "ftp://1.2.3.4:80", false},
		{"empty string", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := validateProxy(tt.input)
			if tt.valid && result == "" {
				t.Errorf("validateProxy(%q) returned empty, want valid", tt.input)
			}
			if !tt.valid && result != "" {
				t.Errorf("validateProxy(%q) = %q, want empty", tt.input, result)
			}
		})
	}
}

func TestManagerNext_RoundRobin(t *testing.T) {
	m := &Manager{proxies: []string{"a", "b", "c"}}

	results := make([]string, 6)
	for i := range results {
		results[i] = m.Next()
	}

	expected := []string{"a", "b", "c", "a", "b", "c"}
	for i, want := range expected {
		if results[i] != want {
			t.Errorf("Next() call %d = %q, want %q", i, results[i], want)
		}
	}
}

func TestManagerNextExcluding(t *testing.T) {
	m := &Manager{proxies: []string{"a", "b", "c"}}
	excluded := map[string]bool{"a": true, "c": true}

	if got := m.NextExcluding(excluded); got != "b" {
		t.Fatalf("NextExcluding() = %q, want b", got)
	}
	if got := m.CountAvailable(excluded); got != 1 {
		t.Fatalf("CountAvailable() = %d, want 1", got)
	}
}

func TestManagerNextExcludingAll(t *testing.T) {
	m := &Manager{proxies: []string{"a", "b"}}
	excluded := map[string]bool{"a": true, "b": true}

	if got := m.NextExcluding(excluded); got != "" {
		t.Fatalf("NextExcluding() = %q, want empty", got)
	}
	if got := m.CountAvailable(excluded); got != 0 {
		t.Fatalf("CountAvailable() = %d, want 0", got)
	}
}

func TestManagerNext_Empty(t *testing.T) {
	m := &Manager{}
	if got := m.Next(); got != "" {
		t.Errorf("Next() on empty manager = %q, want empty", got)
	}
}

func TestManagerCount(t *testing.T) {
	m := &Manager{proxies: []string{"a", "b"}}
	if got := m.Count(); got != 2 {
		t.Errorf("Count() = %d, want 2", got)
	}
}

func TestFromString(t *testing.T) {
	input := "http://user:pass@1.2.3.4:8080\ninvalid\nhttp://5.6.7.8:3128"
	m := FromString(input)
	if m.Count() != 2 {
		t.Errorf("FromString: Count() = %d, want 2", m.Count())
	}

	first := m.Next()
	if first != "http://user:pass@1.2.3.4:8080" {
		t.Errorf("First proxy = %q, want http://user:pass@1.2.3.4:8080", first)
	}
}

func TestFromString_Empty(t *testing.T) {
	m := FromString("")
	if m.Count() != 0 {
		t.Errorf("FromString empty: Count() = %d, want 0", m.Count())
	}
}

func TestParseProxyLine_Whitespace(t *testing.T) {
	result := parseProxyLine("  http://1.2.3.4:8080  ")
	if result != "http://1.2.3.4:8080" {
		t.Errorf("parseProxyLine with whitespace = %q, want trimmed", result)
	}
}
