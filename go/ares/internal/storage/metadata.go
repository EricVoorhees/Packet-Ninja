package storage

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type MetadataMeta struct {
	ETag         string
	LastModified string
	ContentType  string
}

type MetadataEntry struct {
	Key          string `json:"key"`
	FilePath     string `json:"filePath"`
	ETag         string `json:"etag,omitempty"`
	LastModified string `json:"lastModified,omitempty"`
	ContentType  string `json:"contentType,omitempty"`
	UpdatedAt    string `json:"updatedAt"`
}

type MetadataCache struct {
	mu        sync.RWMutex
	dir       string
	indexPath string
	index     map[string]MetadataEntry
}

func NewMetadataCache(root string) (*MetadataCache, error) {
	cache := &MetadataCache{
		dir:       filepath.Join(root, "metadata"),
		indexPath: filepath.Join(root, "indexes", "metadata.json"),
		index:     make(map[string]MetadataEntry),
	}

	if err := os.MkdirAll(cache.dir, 0o755); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(cache.indexPath), 0o755); err != nil {
		return nil, err
	}

	if err := cache.load(); err != nil {
		return nil, err
	}

	return cache, nil
}

func (c *MetadataCache) Lookup(key string) (MetadataEntry, []byte, bool) {
	c.mu.RLock()
	entry, ok := c.index[key]
	c.mu.RUnlock()
	if !ok {
		return MetadataEntry{}, nil, false
	}

	body, err := os.ReadFile(entry.FilePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			c.removeStale(key)
			return MetadataEntry{}, nil, false
		}
		return MetadataEntry{}, nil, false
	}

	return entry, body, true
}

func (c *MetadataCache) Save(key string, body []byte, meta MetadataMeta) (MetadataEntry, error) {
	filePath := filepath.Join(c.dir, hashKey(key)+".json")
	if err := writeFileAtomic(filePath, body); err != nil {
		return MetadataEntry{}, err
	}

	entry := MetadataEntry{
		Key:          key,
		FilePath:     filePath,
		ETag:         meta.ETag,
		LastModified: meta.LastModified,
		ContentType:  meta.ContentType,
		UpdatedAt:    time.Now().UTC().Format(time.RFC3339Nano),
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	c.index[key] = entry
	if err := c.persistLocked(); err != nil {
		return MetadataEntry{}, err
	}

	return entry, nil
}

func (c *MetadataCache) IsFresh(entry MetadataEntry, ttl time.Duration) bool {
	if ttl <= 0 {
		return false
	}

	updatedAt := parseTime(entry.UpdatedAt)
	return time.Since(updatedAt) <= ttl
}

func (c *MetadataCache) ServeCached(w http.ResponseWriter, r *http.Request, key string) (bool, error) {
	entry, payload, ok := c.Lookup(key)
	if !ok {
		return false, nil
	}

	if entry.ETag != "" && r.Header.Get("If-None-Match") == entry.ETag {
		w.WriteHeader(http.StatusNotModified)
		return true, nil
	}

	if entry.ContentType != "" {
		w.Header().Set("Content-Type", entry.ContentType)
	} else {
		w.Header().Set("Content-Type", "application/json")
	}
	if entry.ETag != "" {
		w.Header().Set("ETag", entry.ETag)
	}
	if entry.LastModified != "" {
		w.Header().Set("Last-Modified", entry.LastModified)
	}

	w.WriteHeader(http.StatusOK)
	_, err := w.Write(payload)
	return true, err
}

func (c *MetadataCache) load() error {
	payload, err := os.ReadFile(c.indexPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}

	decoded := make(map[string]MetadataEntry)
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return err
	}

	c.index = decoded
	return nil
}

func (c *MetadataCache) persistLocked() error {
	return writeJSONAtomic(c.indexPath, c.index)
}

func (c *MetadataCache) removeStale(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.index, key)
	_ = c.persistLocked()
}
