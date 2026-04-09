//go:build windows

package main

import (
	"context"
	"net"
	"time"

	"github.com/Microsoft/go-winio"
)

func dialHandshake(endpoint string, timeout time.Duration) (net.Conn, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return winio.DialPipeContext(ctx, endpoint)
}
