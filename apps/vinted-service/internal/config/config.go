package config

import (
	"fmt"
	"os"
	"strings"
)

type Config struct {
	RedisAddr     string
	RedisPassword string
	DatabaseURL   string
	EncryptionKey string
	ListenAddr    string
	// CheckoutDevDirect lets request checkout leave from this host without a
	// member proxy. Development only: on a shared instance every member's
	// checkout would use the same server address.
	CheckoutDevDirect bool
}

func Load() (Config, error) {
	cfg := Config{
		RedisAddr:     value("REDIS_ADDR", "localhost:6379"),
		RedisPassword: strings.TrimSpace(os.Getenv("REDIS_PASSWORD")),
		DatabaseURL:   strings.TrimSpace(os.Getenv("DATABASE_URL")),
		EncryptionKey: strings.TrimSpace(os.Getenv("VINTED_SESSION_ENCRYPTION_KEY")),
		ListenAddr:    value("LISTEN_ADDR", ":4000"),
	}
	production := isProduction()
	if production && cfg.DatabaseURL == "" {
		return Config{}, fmt.Errorf("DATABASE_URL is required in production")
	}
	if production && cfg.EncryptionKey == "" {
		return Config{}, fmt.Errorf("VINTED_SESSION_ENCRYPTION_KEY is required in production")
	}
	cfg.CheckoutDevDirect = strings.EqualFold(strings.TrimSpace(os.Getenv("CHECKOUT_DEV_DIRECT_CONNECTION")), "true")
	if production && cfg.CheckoutDevDirect {
		return Config{}, fmt.Errorf("CHECKOUT_DEV_DIRECT_CONNECTION must not be enabled in production")
	}
	if cfg.DatabaseURL != "" && cfg.EncryptionKey == "" {
		return Config{}, fmt.Errorf("VINTED_SESSION_ENCRYPTION_KEY is required when DATABASE_URL is configured")
	}
	return cfg, nil
}

func value(key, fallback string) string {
	if current := strings.TrimSpace(os.Getenv(key)); current != "" {
		return current
	}
	return fallback
}

func isProduction() bool {
	for _, key := range []string{"APP_ENV", "ENVIRONMENT", "NODE_ENV"} {
		if strings.EqualFold(strings.TrimSpace(os.Getenv(key)), "production") {
			return true
		}
	}
	return false
}
