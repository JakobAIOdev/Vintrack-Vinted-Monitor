package config

import "testing"

func clearConfig(t *testing.T) {
	t.Helper()
	for _, key := range []string{"APP_ENV", "ENVIRONMENT", "NODE_ENV", "DATABASE_URL", "VINTED_SESSION_ENCRYPTION_KEY", "REDIS_ADDR", "REDIS_PASSWORD", "LISTEN_ADDR"} {
		t.Setenv(key, "")
	}
}

func TestLoadDefaultsInDevelopment(t *testing.T) {
	clearConfig(t)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.RedisAddr != "localhost:6379" || cfg.ListenAddr != ":4000" {
		t.Fatalf("unexpected defaults: %#v", cfg)
	}
}

func TestLoadRequiresProductionPersistence(t *testing.T) {
	clearConfig(t)
	t.Setenv("APP_ENV", "production")
	if _, err := Load(); err == nil {
		t.Fatal("expected missing production configuration to fail")
	}
}

func TestLoadRequiresEncryptionWithDatabase(t *testing.T) {
	clearConfig(t)
	t.Setenv("DATABASE_URL", "postgres://example")
	if _, err := Load(); err == nil {
		t.Fatal("expected missing encryption key to fail")
	}
}
