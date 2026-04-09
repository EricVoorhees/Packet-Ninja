package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"package-ninja-ares/internal/config"
	"package-ninja-ares/internal/server"
)

func main() {
	cfg := config.FromEnv()
	logger := log.New(os.Stdout, "ares-registry: ", log.LstdFlags|log.Lmicroseconds)

	engine, err := server.New(cfg, logger)
	if err != nil {
		logger.Fatalf("engine init failed: %v", err)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer cancel()

	logger.Printf("starting: listen=%s upstream=%s dataDir=%s shadow=%t", cfg.ListenAddr, cfg.UpstreamURL, cfg.DataDir, cfg.EnableShadowMode)

	if err := engine.Run(ctx); err != nil {
		logger.Fatalf("engine run failed: %v", err)
	}
}
