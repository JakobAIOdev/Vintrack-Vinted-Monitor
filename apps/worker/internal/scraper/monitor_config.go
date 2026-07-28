package scraper

import (
	"database/sql"
	"fmt"
	"strings"

	"vintrack-worker/internal/model"
)

func monitorConfigFingerprint(mon model.Monitor) string {
	return fmt.Sprintf(
		"query=%s|anti=%s|queryDelayMs=%d|quiet=%v:%d:%d:%s:%d:%s|priceMin=%s|priceMax=%s|size=%s|catalog=%s|brand=%s|color=%s|status=%s|platform=%s|region=%s|allowed=%s|bannedSellers=%s|proxySource=%s|proxies=%s",
		mon.Query,
		nullableString(mon.AntiKeywords),
		mon.QueryDelayMs,
		mon.QuietHoursEnabled,
		mon.QuietHoursStartMinute,
		mon.QuietHoursEndMinute,
		mon.QuietHoursMode,
		mon.QuietHoursDelayMs,
		mon.QuietHoursTimezone,
		nullableInt(mon.PriceMin),
		nullableInt(mon.PriceMax),
		nullableString(mon.SizeID),
		nullableString(mon.CatalogIDs),
		nullableString(mon.BrandIDs),
		nullableString(mon.ColorIDs),
		nullableString(mon.StatusIDs),
		nullableString(mon.VideoGamePlatformIDs),
		mon.Region,
		nullableString(mon.AllowedCountries),
		int64ListFingerprint(mon.BannedSellerIDs),
		mon.ProxySource,
		proxyFingerprint(mon),
	)
}

func proxyFingerprint(mon model.Monitor) string {
	if mon.Proxies.Valid && mon.Proxies.String != "" {
		return nullString(mon.Proxies)
	}
	if mon.ProxySource == "free" {
		return "free"
	}
	if mon.ProxyGroupID == nil {
		return fmt.Sprintf("server:%d", mon.ServerProxyVersion)
	}
	return nullString(mon.Proxies)
}

func nullableInt(v *int) string {
	if v == nil {
		return "<nil>"
	}
	return fmt.Sprintf("%d", *v)
}

func nullableString(v *string) string {
	if v == nil {
		return "<nil>"
	}
	return *v
}

func nullString(v sql.NullString) string {
	if !v.Valid {
		return "<null>"
	}
	return v.String
}

func int64ListFingerprint(values []int64) string {
	if len(values) == 0 {
		return "<none>"
	}
	parts := make([]string, len(values))
	for i, value := range values {
		parts[i] = fmt.Sprintf("%d", value)
	}
	return strings.Join(parts, ",")
}
