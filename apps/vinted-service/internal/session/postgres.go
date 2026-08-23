package session

import (
	"context"
	"database/sql"
	"fmt"
	"runtime"
	"strings"
	"time"

	_ "github.com/lib/pq"
)

type persistentStore struct {
	db     *sql.DB
	cipher *tokenCipher
}

func newPersistentStore(databaseURL, encryptionKey string) (*persistentStore, error) {
	c, err := newTokenCipher(encryptionKey)
	if err != nil {
		return nil, err
	}

	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		return nil, fmt.Errorf("open durable session store: %w", err)
	}
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping durable session store: %w", err)
	}

	maxConns := runtime.NumCPU() * 2
	db.SetMaxOpenConns(maxConns)
	db.SetMaxIdleConns(maxConns / 2)
	db.SetConnMaxLifetime(10 * time.Minute)
	db.SetConnMaxIdleTime(5 * time.Minute)

	return &persistentStore{db: db, cipher: c}, nil
}

func (s *persistentStore) Close() error {
	return s.db.Close()
}

func (s *persistentStore) Save(ctx context.Context, sess VintedSession) error {
	accessToken, err := s.cipher.Encrypt(sess.AccessToken)
	if err != nil {
		return fmt.Errorf("encrypt access token: %w", err)
	}
	refreshToken, err := s.cipher.Encrypt(sess.RefreshToken)
	if err != nil {
		return fmt.Errorf("encrypt refresh token: %w", err)
	}
	cookieHeader, err := s.cipher.Encrypt(sess.CookieHeader)
	if err != nil {
		return fmt.Errorf("encrypt cookie header: %w", err)
	}
	csrfToken, err := s.cipher.Encrypt(sess.CsrfToken)
	if err != nil {
		return fmt.Errorf("encrypt csrf token: %w", err)
	}
	anonID, err := s.cipher.Encrypt(sess.AnonID)
	if err != nil {
		return fmt.Errorf("encrypt anon id: %w", err)
	}
	phoneNumber, err := s.cipher.Encrypt(sess.PhoneNumber)
	if err != nil {
		return fmt.Errorf("encrypt phone number: %w", err)
	}

	if accessToken == "" {
		return fmt.Errorf("access token is required")
	}

	_, err = s.db.ExecContext(ctx, `
		INSERT INTO vinted_sessions (
			user_id,
			vinted_user_id,
			vinted_name,
			access_token_ciphertext,
			refresh_token_ciphertext,
			cookie_header_ciphertext,
			csrf_token_ciphertext,
			anon_id_ciphertext,
			user_agent,
			phone_number_ciphertext,
			browser_linked,
			domain,
			status,
			linked_at,
			last_check,
			warmed_at,
			last_browser_sync_at,
			last_refresh_at,
			last_valid_at,
			invalid_reason,
			updated_at
		)
		VALUES ($1, $2, $3, $4, NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''), NULLIF($10, ''), $11, $12, $13, $14, $15, $16, $17, $18, $19, NULLIF($20, ''), NOW())
		ON CONFLICT (user_id) DO UPDATE SET
			vinted_user_id = EXCLUDED.vinted_user_id,
			vinted_name = EXCLUDED.vinted_name,
			access_token_ciphertext = EXCLUDED.access_token_ciphertext,
			refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
			cookie_header_ciphertext = EXCLUDED.cookie_header_ciphertext,
			csrf_token_ciphertext = EXCLUDED.csrf_token_ciphertext,
			anon_id_ciphertext = EXCLUDED.anon_id_ciphertext,
			user_agent = EXCLUDED.user_agent,
			phone_number_ciphertext = EXCLUDED.phone_number_ciphertext,
			browser_linked = EXCLUDED.browser_linked,
			domain = EXCLUDED.domain,
			status = EXCLUDED.status,
			linked_at = EXCLUDED.linked_at,
			last_check = EXCLUDED.last_check,
			warmed_at = EXCLUDED.warmed_at,
			last_browser_sync_at = EXCLUDED.last_browser_sync_at,
			last_refresh_at = EXCLUDED.last_refresh_at,
			last_valid_at = EXCLUDED.last_valid_at,
			invalid_reason = EXCLUDED.invalid_reason,
			updated_at = NOW()`,
		sess.UserID,
		sess.VintedUserID,
		strings.TrimSpace(sess.VintedName),
		accessToken,
		refreshToken,
		cookieHeader,
		csrfToken,
		anonID,
		strings.TrimSpace(sess.UserAgent),
		phoneNumber,
		sess.BrowserLinked,
		strings.TrimSpace(sess.Domain),
		firstNonEmptyLocal(sess.Status, "active"),
		parseNullableTime(sess.LinkedAt),
		parseNullableTime(sess.LastCheck),
		parseNullableTime(sess.WarmedAt),
		parseNullableTime(sess.LastBrowserSync),
		parseNullableTime(sess.LastRefreshAt),
		parseNullableTime(sess.LastValidAt),
		strings.TrimSpace(sess.InvalidReason),
	)
	if err != nil {
		return fmt.Errorf("save durable session: %w", err)
	}
	return nil
}

func (s *persistentStore) Get(ctx context.Context, userID string) (*VintedSession, error) {
	row := s.db.QueryRowContext(ctx, persistentSessionSelectSQL()+` WHERE user_id = $1`, userID)
	return s.scan(row)
}

func (s *persistentStore) List(ctx context.Context) ([]VintedSession, error) {
	rows, err := s.db.QueryContext(ctx, persistentSessionSelectSQL()+` ORDER BY updated_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("list durable sessions: %w", err)
	}
	defer rows.Close()

	sessions := make([]VintedSession, 0)
	for rows.Next() {
		sess, err := s.scan(rows)
		if err != nil {
			return nil, err
		}
		if sess != nil {
			sessions = append(sessions, *sess)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return sessions, nil
}

func (s *persistentStore) Delete(ctx context.Context, userID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM vinted_sessions WHERE user_id = $1`, userID)
	if err != nil {
		return fmt.Errorf("delete durable session: %w", err)
	}
	return nil
}

func (s *persistentStore) SaveBrowserLink(ctx context.Context, tokenHash string, link BrowserLink) error {
	createdAt := parseNullableTime(link.CreatedAt)
	if createdAt == nil {
		createdAt = time.Now().UTC()
	}

	_, err := s.db.ExecContext(ctx, `
		INSERT INTO vinted_browser_links (
			user_id,
			token_hash,
			created_at,
			last_used_at,
			updated_at
		)
		VALUES ($1, $2, $3, $4, NOW())
		ON CONFLICT (user_id) DO UPDATE SET
			token_hash = EXCLUDED.token_hash,
			created_at = EXCLUDED.created_at,
			last_used_at = EXCLUDED.last_used_at,
			updated_at = NOW()`,
		link.UserID,
		tokenHash,
		createdAt,
		parseNullableTime(link.LastUsedAt),
	)
	if err != nil {
		return fmt.Errorf("save durable browser link: %w", err)
	}
	return nil
}

func (s *persistentStore) GetBrowserLinkByTokenHash(ctx context.Context, tokenHash string) (*BrowserLink, error) {
	var link BrowserLink
	var createdAt time.Time
	var lastUsedAt sql.NullTime
	err := s.db.QueryRowContext(ctx, `
		SELECT user_id, created_at, last_used_at
		FROM vinted_browser_links
		WHERE token_hash = $1`, tokenHash).Scan(
		&link.UserID,
		&createdAt,
		&lastUsedAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get durable browser link: %w", err)
	}

	link.CreatedAt = createdAt.UTC().Format(time.RFC3339)
	link.LastUsedAt = formatNullTime(lastUsedAt)
	link.Persistent = true
	return &link, nil
}

func (s *persistentStore) HasBrowserLink(ctx context.Context, userID string) (bool, error) {
	var exists bool
	if err := s.db.QueryRowContext(ctx,
		`SELECT EXISTS(SELECT 1 FROM vinted_browser_links WHERE user_id = $1)`,
		userID,
	).Scan(&exists); err != nil {
		return false, fmt.Errorf("check durable browser link: %w", err)
	}
	return exists, nil
}

func (s *persistentStore) DeleteBrowserLink(ctx context.Context, userID string) error {
	if _, err := s.db.ExecContext(ctx,
		`DELETE FROM vinted_browser_links WHERE user_id = $1`,
		userID,
	); err != nil {
		return fmt.Errorf("delete durable browser link: %w", err)
	}
	return nil
}

type rowScanner interface {
	Scan(dest ...interface{}) error
}

func (s *persistentStore) scan(row rowScanner) (*VintedSession, error) {
	var sess VintedSession
	var accessToken, refreshToken, cookieHeader, csrfToken, anonID, phoneNumber sql.NullString
	var userAgent, invalidReason sql.NullString
	var linkedAt, lastCheck, warmedAt, lastBrowserSyncAt, lastRefreshAt, lastValidAt sql.NullTime

	err := row.Scan(
		&sess.UserID,
		&sess.VintedUserID,
		&sess.VintedName,
		&accessToken,
		&refreshToken,
		&cookieHeader,
		&csrfToken,
		&anonID,
		&userAgent,
		&phoneNumber,
		&sess.BrowserLinked,
		&sess.Domain,
		&sess.Status,
		&linkedAt,
		&lastCheck,
		&warmedAt,
		&lastBrowserSyncAt,
		&lastRefreshAt,
		&lastValidAt,
		&invalidReason,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("scan durable session: %w", err)
	}

	var decryptErr error
	if sess.AccessToken, decryptErr = s.decryptNull(accessToken); decryptErr != nil {
		return nil, decryptErr
	}
	if sess.RefreshToken, decryptErr = s.decryptNull(refreshToken); decryptErr != nil {
		return nil, decryptErr
	}
	if sess.CookieHeader, decryptErr = s.decryptNull(cookieHeader); decryptErr != nil {
		return nil, decryptErr
	}
	if sess.CsrfToken, decryptErr = s.decryptNull(csrfToken); decryptErr != nil {
		return nil, decryptErr
	}
	if sess.AnonID, decryptErr = s.decryptNull(anonID); decryptErr != nil {
		return nil, decryptErr
	}
	if sess.PhoneNumber, decryptErr = s.decryptNull(phoneNumber); decryptErr != nil {
		return nil, decryptErr
	}

	sess.UserAgent = userAgent.String
	sess.LinkedAt = formatNullTime(linkedAt)
	sess.LastCheck = formatNullTime(lastCheck)
	sess.WarmedAt = formatNullTime(warmedAt)
	sess.LastBrowserSync = formatNullTime(lastBrowserSyncAt)
	sess.LastRefreshAt = formatNullTime(lastRefreshAt)
	sess.LastValidAt = formatNullTime(lastValidAt)
	sess.InvalidReason = invalidReason.String
	return &sess, nil
}

func (s *persistentStore) decryptNull(value sql.NullString) (string, error) {
	if !value.Valid || strings.TrimSpace(value.String) == "" {
		return "", nil
	}
	decrypted, err := s.cipher.Decrypt(value.String)
	if err != nil {
		return "", err
	}
	return decrypted, nil
}

func persistentSessionSelectSQL() string {
	return `
		SELECT
			user_id,
			vinted_user_id,
			vinted_name,
			access_token_ciphertext,
			refresh_token_ciphertext,
			cookie_header_ciphertext,
			csrf_token_ciphertext,
			anon_id_ciphertext,
			user_agent,
			phone_number_ciphertext,
			browser_linked,
			domain,
			status,
			linked_at,
			last_check,
			warmed_at,
			last_browser_sync_at,
			last_refresh_at,
			last_valid_at,
			invalid_reason
		FROM vinted_sessions`
}

func parseNullableTime(value string) interface{} {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	parsed, err := time.Parse(time.RFC3339, trimmed)
	if err != nil {
		return nil
	}
	return parsed
}

func formatNullTime(value sql.NullTime) string {
	if !value.Valid {
		return ""
	}
	return value.Time.UTC().Format(time.RFC3339)
}

func firstNonEmptyLocal(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
