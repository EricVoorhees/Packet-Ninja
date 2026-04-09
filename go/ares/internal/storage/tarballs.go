package storage

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

type TarballMeta struct {
	ETag         string
	LastModified string
	ContentType  string
}

type TarballEntry struct {
	Key           string `json:"key"`
	Digest        string `json:"digest"`
	FilePath      string `json:"filePath"`
	ETag          string `json:"etag,omitempty"`
	LastModified  string `json:"lastModified,omitempty"`
	ContentType   string `json:"contentType,omitempty"`
	ContentLength int64  `json:"contentLength"`
	UpdatedAt     string `json:"updatedAt"`
}

type TarballStore struct {
	mu        sync.RWMutex
	casDir    string
	tmpDir    string
	indexPath string
	index     map[string]TarballEntry
}

func NewTarballStore(root string) (*TarballStore, error) {
	store := &TarballStore{
		casDir:    filepath.Join(root, "cas"),
		tmpDir:    filepath.Join(root, "tmp"),
		indexPath: filepath.Join(root, "indexes", "tarballs.json"),
		index:     make(map[string]TarballEntry),
	}

	if err := os.MkdirAll(store.casDir, 0o755); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(store.tmpDir, 0o755); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(store.indexPath), 0o755); err != nil {
		return nil, err
	}

	if err := store.load(); err != nil {
		return nil, err
	}

	return store, nil
}

func (s *TarballStore) Lookup(key string) (TarballEntry, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	entry, ok := s.index[key]
	return entry, ok
}

func (s *TarballStore) ServeIfPresent(w http.ResponseWriter, r *http.Request, key string) (bool, error) {
	entry, ok := s.Lookup(key)
	if !ok {
		return false, nil
	}

	file, err := os.Open(entry.FilePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			s.removeStale(key)
			return false, nil
		}
		return false, err
	}
	defer file.Close()

	if entry.ETag != "" && r.Header.Get("If-None-Match") == entry.ETag {
		w.WriteHeader(http.StatusNotModified)
		return true, nil
	}

	if entry.ETag != "" {
		w.Header().Set("ETag", entry.ETag)
	}
	if entry.LastModified != "" {
		w.Header().Set("Last-Modified", entry.LastModified)
	}
	if entry.ContentType != "" {
		w.Header().Set("Content-Type", entry.ContentType)
	}
	if entry.ContentLength > 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(entry.ContentLength, 10))
	}

	modTime := parseTime(entry.UpdatedAt)
	http.ServeContent(w, r, filepath.Base(entry.FilePath), modTime, file)
	return true, nil
}

func (s *TarballStore) StreamAndCache(key string, src io.Reader, dst io.Writer, meta TarballMeta) (TarballEntry, error) {
	tempFile, err := os.CreateTemp(s.tmpDir, "tarball-*.tmp")
	if err != nil {
		return TarballEntry{}, err
	}
	tempPath := tempFile.Name()
	closeAndRemoveTemp := func() {
		_ = tempFile.Close()
		_ = os.Remove(tempPath)
	}

	hasher := sha256.New()
	cacheWriter := io.MultiWriter(tempFile, hasher)
	buffer := make([]byte, 256*1024)
	var bytesWritten int64
	destinationFailed := false

	for {
		readCount, readErr := src.Read(buffer)
		if readCount > 0 {
			chunk := buffer[:readCount]
			written, writeErr := cacheWriter.Write(chunk)
			bytesWritten += int64(written)
			if writeErr != nil {
				closeAndRemoveTemp()
				return TarballEntry{}, writeErr
			}
			if written != readCount {
				closeAndRemoveTemp()
				return TarballEntry{}, io.ErrShortWrite
			}

			if dst != nil && !destinationFailed {
				if _, dstErr := dst.Write(chunk); dstErr != nil {
					// Do not fail cache population on downstream socket churn.
					// Followers can still succeed from the completed cache artifact.
					destinationFailed = true
				}
			}
		}

		if readErr == nil {
			continue
		}
		if errors.Is(readErr, io.EOF) {
			break
		}

		closeAndRemoveTemp()
		return TarballEntry{}, readErr
	}

	if closeErr := tempFile.Close(); closeErr != nil {
		_ = os.Remove(tempPath)
		return TarballEntry{}, closeErr
	}

	digest := hex.EncodeToString(hasher.Sum(nil))
	finalPath := filepath.Join(s.casDir, digest)

	s.mu.Lock()
	defer s.mu.Unlock()

	if _, statErr := os.Stat(finalPath); errors.Is(statErr, os.ErrNotExist) {
		if err := os.Rename(tempPath, finalPath); err != nil {
			_ = os.Remove(tempPath)
			return TarballEntry{}, err
		}
	} else {
		_ = os.Remove(tempPath)
	}

	entry := TarballEntry{
		Key:           key,
		Digest:        digest,
		FilePath:      finalPath,
		ETag:          meta.ETag,
		LastModified:  meta.LastModified,
		ContentType:   meta.ContentType,
		ContentLength: bytesWritten,
		UpdatedAt:     time.Now().UTC().Format(time.RFC3339Nano),
	}

	s.index[key] = entry
	if err := s.persistLocked(); err != nil {
		return TarballEntry{}, err
	}

	return entry, nil
}

func (s *TarballStore) load() error {
	payload, err := os.ReadFile(s.indexPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}

	decoded := make(map[string]TarballEntry)
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return err
	}

	s.index = decoded
	return nil
}

func (s *TarballStore) persistLocked() error {
	return writeJSONAtomic(s.indexPath, s.index)
}

func (s *TarballStore) removeStale(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.index, key)
	_ = s.persistLocked()
}
