# ─── Stage 1: Build ───────────────────────────────────────────────────────────
FROM golang:1.27.0-alpine AS builder

WORKDIR /app

# Copy dependency files first for better layer caching
COPY go.mod go.sum ./
RUN go mod download

# Copy the rest of the source
COPY . .

# Build a statically linked binary
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o dnd-music-manager .

# ─── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM alpine:3.24

WORKDIR /app

# ca-certificates for any outbound HTTPS calls; tzdata for correct timestamps
RUN apk add --no-cache ca-certificates tzdata

# Copy the compiled binary from the builder stage
COPY --from=builder /app/dnd-music-manager .

# Copy the static web assets
COPY web/ ./web/

# Create the uploads directory (will be overridden by the volume mount)
RUN mkdir -p /app/uploads

EXPOSE 8080

ENTRYPOINT ["/app/dnd-music-manager"]