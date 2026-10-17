package cache

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestSellerCacheReadHonorsDeadlineOnSlowRedis(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	release := make(chan struct{})
	getStarted := make(chan struct{}, 1)
	acceptDone := make(chan struct{})
	var handlers sync.WaitGroup
	go func() {
		defer close(acceptDone)
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			handlers.Add(1)
			go func() {
				defer handlers.Done()
				defer conn.Close()
				reader := bufio.NewReader(conn)
				for {
					args, err := readDeadlineTestCommand(reader)
					if err != nil || len(args) == 0 {
						return
					}
					switch strings.ToLower(args[0]) {
					case "hello":
						// RESP2-only server; go-redis supports this fallback.
						_, _ = io.WriteString(conn, "-ERR unknown command 'hello'\r\n")
					case "ping":
						_, _ = io.WriteString(conn, "+PONG\r\n")
					case "get":
						select {
						case getStarted <- struct{}{}:
						default:
						}
						<-release
						return
					default:
						_, _ = io.WriteString(conn, "+OK\r\n")
					}
				}
			}()
		}
	}()
	t.Cleanup(func() {
		close(release)
		listener.Close()
		<-acceptDone
		handlers.Wait()
	})
	cache, err := NewRedisCache(listener.Addr().String(), "", 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cache.client.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	done := make(chan bool, 1)
	go func() {
		_, ok := cache.GetSellerInfo(ctx, "www.vinted.de", 123)
		done <- ok
	}()
	select {
	case <-getStarted:
	case <-time.After(time.Second):
		t.Fatal("test did not reach the slow Redis GET")
	}
	select {
	case ok := <-done:
		if ok {
			t.Fatal("timed-out cache lookup returned seller data")
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("seller lookup ignored its 50ms budget and waited for socket timeout")
	}
}

func readDeadlineTestCommand(reader *bufio.Reader) ([]string, error) {
	header, err := reader.ReadString('\n')
	if err != nil {
		return nil, err
	}
	count, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(header, "*")))
	if err != nil || count < 1 || count > 64 {
		return nil, fmt.Errorf("invalid test command array")
	}
	args := make([]string, count)
	for i := range args {
		header, err = reader.ReadString('\n')
		if err != nil {
			return nil, err
		}
		length, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(header, "$")))
		if err != nil || length < 0 || length > 4096 {
			return nil, fmt.Errorf("invalid test bulk string")
		}
		value := make([]byte, length+2)
		if _, err := io.ReadFull(reader, value); err != nil {
			return nil, err
		}
		args[i] = string(value[:length])
	}
	return args, nil
}
