FROM golang:1.25-alpine AS builder

WORKDIR /build

# Dependencies
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download

# Source Code
COPY . .

ARG GO_BUILD_CPUS

# Build
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    if [ -n "$GO_BUILD_CPUS" ]; then \
        CGO_ENABLED=0 GOOS=linux GOMAXPROCS="$GO_BUILD_CPUS" go build -p "$GO_BUILD_CPUS" -o worker ./cmd; \
    else \
        CGO_ENABLED=0 GOOS=linux go build -o worker ./cmd; \
    fi

# Runtime Image
FROM alpine:latest

RUN apk --no-cache add ca-certificates tzdata

WORKDIR /app

COPY --from=builder /build/worker .

CMD ["./worker"]
