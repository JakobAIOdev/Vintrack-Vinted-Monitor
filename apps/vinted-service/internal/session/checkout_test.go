package session

import (
	"bytes"
	"context"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func TestAutoCheckoutClaimPersistsAcrossPreparationExpiryAndRelinking(t *testing.T) {
	m := checkoutTestManager(t)
	sess := &VintedSession{UserID: "synthetic-user", VintedUserID: 42, Domain: "www.vinted.de", LinkedAt: "first"}
	acquired, err := m.ReserveAutoCheckout(sess, 123)
	if err != nil || !acquired {
		t.Fatal("first claim failed")
	}
	sess.LinkedAt = "second"
	if acquired, err = m.ReserveAutoCheckout(sess, 123); err != nil || acquired {
		t.Fatal("relink allowed duplicate")
	}
	if acquired, err = m.ReserveAutoCheckout(sess, 124); err != nil || !acquired {
		t.Fatal("different item rejected")
	}
	other := *sess
	other.VintedUserID = 43
	if acquired, err = m.ReserveAutoCheckout(&other, 123); err != nil || !acquired {
		t.Fatal("different account rejected")
	}
}

// Use a disposable local Redis process, never a configured application DB.
// No extra test dependency is required; Redis-less environments skip this test.
func checkoutTestManager(t *testing.T) *Manager {
	t.Helper()
	binary, err := exec.LookPath("redis-server")
	if err != nil {
		t.Skip("redis-server is required for isolated checkout cache tests")
	}
	dir, err := os.MkdirTemp("", "vintrack-redis-")
	if err != nil {
		t.Fatal(err)
	}
	socket := filepath.Join(dir, "redis.sock")
	ctx, cancel := context.WithCancel(context.Background())
	command := exec.CommandContext(ctx, binary, "--port", "0", "--unixsocket", socket, "--unixsocketperm", "700", "--save", "", "--appendonly", "no", "--dir", dir)
	var output bytes.Buffer
	command.Stdout, command.Stderr = &output, &output
	if err := command.Start(); err != nil {
		cancel()
		t.Fatal(err)
	}
	client := redis.NewClient(&redis.Options{Network: "unix", Addr: socket, MaxRetries: -1})
	t.Cleanup(func() { _ = client.Close(); cancel(); _ = command.Wait(); _ = os.RemoveAll(dir) })
	deadline := time.Now().Add(2 * time.Second)
	for {
		connection, err := net.DialTimeout("unix", socket, 50*time.Millisecond)
		if err == nil {
			_ = connection.Close()
			break
		}
		if time.Now().After(deadline) {
			cancel()
			_ = command.Wait()
			t.Fatalf("isolated Redis did not start: %s", output.String())
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := client.Ping(ctx).Err(); err != nil {
		t.Fatal(err)
	}
	return &Manager{redis: client, ctx: ctx}
}

func TestCheckoutPreparationConcurrentClaimsAndLockOwnership(t *testing.T) {
	m := checkoutTestManager(t)
	sess := &VintedSession{UserID: "synthetic-user", VintedUserID: 42, Domain: "www.vinted.de", LinkedAt: "synthetic-link-generation"}
	var wg sync.WaitGroup
	tokens := make(chan string, 8)
	errors := make(chan error, 8)
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			token, acquired, err := m.AcquireCheckoutPreparation(sess, 123)
			if err != nil {
				errors <- err
			}
			if acquired {
				tokens <- token
			}
		}()
	}
	wg.Wait()
	close(tokens)
	close(errors)
	for err := range errors {
		t.Fatal(err)
	}
	if len(tokens) != 1 {
		t.Fatalf("concurrent owners = %d, want 1", len(tokens))
	}
	token := <-tokens
	link := CheckoutLink{ItemID: 123, SellerID: 456, Status: "checkout_building", TransactionID: 77}
	if err := m.SaveCheckoutPreparation(sess, token, link); err != nil {
		t.Fatal(err)
	}
	if err := m.ReleaseCheckoutPreparation(sess, 123, "another-owner"); err != nil {
		t.Fatal(err)
	}
	if _, acquired, err := m.AcquireCheckoutPreparation(sess, 123); err != nil || acquired {
		t.Fatal("wrong owner released checkout lock")
	}
	if err := m.ReleaseCheckoutPreparation(sess, 123, token); err != nil {
		t.Fatal(err)
	}
	newToken, acquired, err := m.AcquireCheckoutPreparation(sess, 123)
	if err != nil || !acquired || newToken == token {
		t.Fatal("lock was not released for the next owner")
	}
	if err := m.SaveCheckoutPreparation(sess, token, link); err == nil {
		t.Fatal("old owner overwrote the new owner's state")
	}
	cached, err := m.GetCheckoutPreparation(sess, 123)
	if err != nil || cached == nil || cached.TransactionID != 77 {
		t.Fatal("partial checkout checkpoint was lost")
	}
	if ttl := m.redis.PTTL(m.ctx, checkoutPreparationKey(sess, 123)).Val(); ttl <= 0 || ttl > CheckoutPreparationTTL {
		t.Fatalf("unexpected cache lifetime: %s", ttl)
	}
	for _, change := range []func(*VintedSession){
		func(s *VintedSession) { s.UserID = "another-member" },
		func(s *VintedSession) { s.VintedUserID = 99 },
		func(s *VintedSession) { s.Domain = "www.vinted.fr" },
		func(s *VintedSession) { s.LinkedAt = "relinked-generation" },
	} {
		other := *sess
		change(&other)
		if cached, err := m.GetCheckoutPreparation(&other, 123); err != nil || cached != nil {
			t.Fatal("checkout cache crossed the member/account/domain/link boundary")
		}
	}
}
