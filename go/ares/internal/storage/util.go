package storage

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

func writeJSONAtomic(targetPath string, payload any) error {
	encoded, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}

	encoded = append(encoded, '\n')
	return writeFileAtomic(targetPath, encoded)
}

func writeFileAtomic(targetPath string, content []byte) error {
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		return err
	}

	tempPath := fmt.Sprintf(
		"%s.tmp-%d-%d",
		targetPath,
		os.Getpid(),
		time.Now().UnixNano(),
	)

	if err := os.WriteFile(tempPath, content, 0o644); err != nil {
		return err
	}

	return os.Rename(tempPath, targetPath)
}

func hashKey(input string) string {
	sum := sha256.Sum256([]byte(input))
	return hex.EncodeToString(sum[:])
}

func parseTime(value string) time.Time {
	if value == "" {
		return time.Now().UTC()
	}

	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Now().UTC()
	}

	return parsed
}
