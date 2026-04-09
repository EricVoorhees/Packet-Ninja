//go:build !windows

package main

import (
	"net"
	"time"
)

func dialHandshake(endpoint string, timeout time.Duration) (net.Conn, error) {
	return net.DialTimeout("unix", endpoint, timeout)
}
