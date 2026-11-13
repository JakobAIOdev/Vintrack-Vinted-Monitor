package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
	"vintrack-vinted/internal/checkoutagent"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	log.SetOutput(io.Discard) // Client diagnostics must never print session responses.
	if len(os.Args) < 2 {
		return fmt.Errorf("usage: checkout-agent pair --server https://your-vintrack | run | forget")
	}
	home, err := os.UserConfigDir()
	if err != nil {
		return fmt.Errorf("could not locate user configuration directory")
	}
	path := filepath.Join(home, "vintrack", "checkout-agent.json")
	flags := flag.NewFlagSet("checkout-agent", flag.ContinueOnError)
	origin := flags.String("server", "", "Vintrack HTTPS origin")
	if err := flags.Parse(os.Args[2:]); err != nil {
		return err
	}
	// A plain kill or a logout sends SIGTERM. Both signals stop polling and let
	// a job that already sent its payment request report the outcome.
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	switch os.Args[1] {
	case "pair":
		api, err := checkoutagent.NewAPI(checkoutagent.Config{Server: *origin})
		if err != nil {
			return err
		}
		fmt.Printf("Pair only with your own Vintrack instance: %s\nPaste the one-time code from Account: ", api.Config.Server)
		code, err := bufio.NewReader(io.LimitReader(os.Stdin, 256)).ReadString('\n')
		if err != nil && err != io.EOF {
			return fmt.Errorf("could not read pairing code")
		}
		if err := api.Pair(ctx, strings.TrimSpace(code)); err != nil {
			return err
		}
		if err := saveConfig(path, api.Config); err != nil {
			return err
		}
		fmt.Println("Paired. Start with checkout-agent run; keep this process running for checkout.")
		return nil
	case "forget":
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("could not remove device credential")
		}
		fmt.Println("Local device credential removed. Revoke the device in Vintrack Account as well.")
		return nil
	case "run":
		info, err := os.Lstat(path)
		if err != nil || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("pair this device first")
		}
		if runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0 {
			return fmt.Errorf("agent config permissions must be 0600")
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("could not read device credential")
		}
		var config checkoutagent.Config
		if json.Unmarshal(data, &config) != nil || len(config.Token) != 64 {
			return fmt.Errorf("pair this device again")
		}
		api, err := checkoutagent.NewAPI(config)
		if err != nil {
			return err
		}
		fmt.Println("Checkout agent running. Only explicit Vintrack checkout jobs will execute. Browser not required.")
		notice := ""
		for ctx.Err() == nil {
			job, status, err := api.Next(ctx)
			if ctx.Err() != nil {
				break
			}
			if err != nil {
				failure := classifyPollFailure(status, err)
				if failure.fatal {
					return errors.New(failure.notice)
				}
				// Say it once, not on every poll.
				if failure.notice != notice {
					notice = failure.notice
					fmt.Fprintln(os.Stderr, notice)
				}
				select {
				case <-ctx.Done():
				case <-time.After(failure.wait):
				}
				continue
			}
			notice = ""
			if job == nil {
				continue
			}
			if err := api.Execute(ctx, job, checkoutagent.DefaultFactory); err != nil {
				if errors.Is(err, checkoutagent.ErrSessionVerification) {
					return err
				}
				fmt.Fprintln(os.Stderr, err)
			} else {
				fmt.Println("Checkout job finished. Review its result in Vintrack.")
			}
			// Job sessions exist only in memory and are never written to the config.
			job.Session.AccessToken = ""
			job.Session.CookieHeader = ""
			job.Session.CsrfToken = ""
		}
		return nil
	default:
		return fmt.Errorf("unknown command")
	}
}

type pollFailure struct {
	fatal  bool
	wait   time.Duration
	notice string
}

// classifyPollFailure decides what a failed poll means. The agent gives up
// only when its credential is gone or its pairing no longer matches the linked
// account. A rejected job, a disabled module or a coordinator outage never
// ends the process; the agent waits and polls again.
func classifyPollFailure(status int, err error) pollFailure {
	var refusal *checkoutagent.CoordinatorError
	code := ""
	if errors.As(err, &refusal) {
		code = refusal.Code
	}
	switch {
	case status == 401:
		return pollFailure{fatal: true, notice: "Device credential expired or was revoked. Pair this device again."}
	case status == 409 && code == checkoutagent.PairingMismatch:
		return pollFailure{fatal: true, notice: "The linked Vinted account changed. Pair this device again."}
	case status == 403:
		return pollFailure{wait: time.Minute, notice: "Checkout is switched off or its risk warning is not accepted in Vintrack Account. Waiting."}
	default:
		return pollFailure{wait: 10 * time.Second, notice: "Coordinator unavailable. Waiting; claimed checkout jobs are never replayed."}
	}
}
func saveConfig(path string, config checkoutagent.Config) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return fmt.Errorf("could not create agent config directory")
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".agent-*")
	if err != nil {
		return fmt.Errorf("could not create device credential")
	}
	defer os.Remove(file.Name())
	if err := file.Chmod(0600); err != nil {
		file.Close()
		return fmt.Errorf("could not protect device credential")
	}
	if err := json.NewEncoder(file).Encode(config); err != nil {
		file.Close()
		return fmt.Errorf("could not save device credential")
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("could not save device credential")
	}
	if err := os.Rename(file.Name(), path); err != nil {
		return fmt.Errorf("could not replace device credential")
	}
	return nil
}
