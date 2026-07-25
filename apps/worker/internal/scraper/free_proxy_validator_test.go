package scraper

import (
	"context"
	"net"
	"testing"
	"time"
)

func TestValidateFreeProxyHonorsContextDeadline(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()

	done := make(chan struct{})
	defer close(done)
	go func() {
		for {
			conn, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			go func() {
				defer conn.Close()
				<-done
			}()
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	startedAt := time.Now()
	_, err = ValidateFreeProxy(ctx, "http://"+listener.Addr().String(), "de", 2500)
	elapsed := time.Since(startedAt)

	if err == nil {
		t.Fatal("expected validation to fail when the context deadline expires")
	}
	if elapsed > time.Second {
		t.Fatalf("validation returned after %s, expected context cancellation within 1s", elapsed)
	}
}

func TestValidateFreeProxyHonorsContextDeadlineForSOCKS5(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()

	done := make(chan struct{})
	accepted := make(chan struct{}, 1)
	defer close(done)
	go func() {
		for {
			conn, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			select {
			case accepted <- struct{}{}:
			default:
			}
			go func() {
				defer conn.Close()
				<-done
			}()
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	startedAt := time.Now()
	_, err = ValidateFreeProxy(ctx, "socks5://"+listener.Addr().String(), "de", 2500)
	elapsed := time.Since(startedAt)

	if err == nil {
		t.Fatal("expected validation to fail when the SOCKS5 handshake deadline expires")
	}
	select {
	case <-accepted:
	case <-time.After(250 * time.Millisecond):
		t.Fatal("SOCKS5 validation never connected to the proxy listener")
	}
	if elapsed > time.Second {
		t.Fatalf("SOCKS5 validation returned after %s, expected context cancellation within 1s", elapsed)
	}
}

func TestFreeProxyRequestTimeoutUsesConfiguredLatencyBudget(t *testing.T) {
	tests := []struct {
		name         string
		maxLatencyMs int
		want         time.Duration
	}{
		{name: "default", maxLatencyMs: 0, want: 2500 * time.Millisecond},
		{name: "configured", maxLatencyMs: 3000, want: 3 * time.Second},
		{name: "minimum", maxLatencyMs: 200, want: 500 * time.Millisecond},
		{name: "maximum", maxLatencyMs: 6000, want: 5 * time.Second},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := freeProxyRequestTimeout(context.Background(), test.maxLatencyMs); got != test.want {
				t.Fatalf("freeProxyRequestTimeout(%d) = %s, want %s", test.maxLatencyMs, got, test.want)
			}
		})
	}
}
