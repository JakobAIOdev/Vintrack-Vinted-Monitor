FROM golang:1.22-alpine AS builder

WORKDIR /build

# Dependencies
COPY go.mod go.sum ./
RUN go mod download

# Source Code
COPY . .

# Build
RUN CGO_ENABLED=0 GOOS=linux go build -o worker ./cmd/main.go

# Runtime Image
FROM alpine:latest

RUN apk --no-cache add ca-certificates tzdata

WORKDIR /app

COPY --from=builder /build/worker .

CMD ["./worker"]
