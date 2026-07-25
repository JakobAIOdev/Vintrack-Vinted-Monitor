package scraper

import (
	"errors"
	"fmt"
)

type httpStatusError struct {
	operation  string
	statusCode int
}

func (e *httpStatusError) Error() string {
	return fmt.Sprintf("%s returned %d", e.operation, e.statusCode)
}

func statusCodeFromError(err error) int {
	var statusErr *httpStatusError
	if errors.As(err, &statusErr) {
		return statusErr.statusCode
	}
	return 0
}
