package storage

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type flakyWriter struct {
	writesBeforeFailure int
	writes              int
}

func (w *flakyWriter) Write(p []byte) (int, error) {
	if w.writes >= w.writesBeforeFailure {
		return 0, errors.New("simulated downstream write failure")
	}
	w.writes += 1
	return len(p), nil
}

func TestTarballStoreStreamAndCacheSurvivesDestinationFailure(t *testing.T) {
	root := t.TempDir()
	store, err := NewTarballStore(root)
	if err != nil {
		t.Fatalf("new tarball store failed: %v", err)
	}

	payload := bytes.Repeat([]byte("x"), 1024*32)
	destination := &flakyWriter{writesBeforeFailure: 1}

	entry, err := store.StreamAndCache(
		"tarball:/demo/-/demo-1.0.0.tgz",
		bytes.NewReader(payload),
		destination,
		TarballMeta{ContentType: "application/octet-stream"},
	)
	if err != nil {
		t.Fatalf("stream and cache failed: %v", err)
	}

	if entry.ContentLength != int64(len(payload)) {
		t.Fatalf("content length mismatch: got=%d expected=%d", entry.ContentLength, len(payload))
	}
	if entry.FilePath == "" {
		t.Fatalf("expected file path to be populated")
	}
	if _, statErr := os.Stat(entry.FilePath); statErr != nil {
		t.Fatalf("expected cached file at %s, stat err: %v", entry.FilePath, statErr)
	}

	cached, readErr := os.ReadFile(entry.FilePath)
	if readErr != nil {
		t.Fatalf("read cached payload failed: %v", readErr)
	}
	if !bytes.Equal(cached, payload) {
		t.Fatalf("cached payload mismatch")
	}

	if filepath.Dir(entry.FilePath) != filepath.Join(root, "cas") {
		t.Fatalf("expected cas storage path, got %s", entry.FilePath)
	}
}
