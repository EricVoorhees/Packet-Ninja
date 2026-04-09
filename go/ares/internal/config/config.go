package config

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	defaultListenAddr       = "127.0.0.1:4874"
	defaultUpstreamURL      = "https://registry.npmjs.org"
	defaultDataDirSuffix    = ".package-ninja/ares"
	defaultRequestTimeoutMs = 30_000
	defaultMetadataTTLms    = 15_000
	defaultShadowTimeoutMs  = 2_000
	defaultParityEntries    = 300
)

type Config struct {
	ListenAddr       string
	UpstreamURL      string
	DataDir          string
	RequestTimeout   time.Duration
	MetadataTTL      time.Duration
	ShadowTargetURL  string
	ShadowTimeout    time.Duration
	EnableShadowMode bool
	StrictParity     bool
	ParityReportPath string
	ParityMaxEntries int
}

func FromEnv() Config {
	dataDir := readEnv("PACKAGE_NINJA_ARES_DATA_DIR", "")
	if strings.TrimSpace(dataDir) == "" {
		cwd, err := os.Getwd()
		if err != nil {
			cwd = "."
		}

		dataDir = filepath.Join(cwd, filepath.FromSlash(defaultDataDirSuffix))
	}

	shadowTarget := readEnv("PACKAGE_NINJA_ARES_SHADOW_URL", "")
	enableShadowMode := strings.TrimSpace(shadowTarget) != ""
	parityReportPath := readEnv("PACKAGE_NINJA_ARES_PARITY_REPORT_PATH", filepath.Join(dataDir, "parity-report.json"))
	strictParity := readBoolEnv("PACKAGE_NINJA_ARES_STRICT_PARITY", false)

	return Config{
		ListenAddr:       readEnv("PACKAGE_NINJA_ARES_LISTEN", defaultListenAddr),
		UpstreamURL:      strings.TrimRight(readEnv("PACKAGE_NINJA_ARES_UPSTREAM", defaultUpstreamURL), "/"),
		DataDir:          dataDir,
		RequestTimeout:   time.Duration(readIntEnv("PACKAGE_NINJA_ARES_REQUEST_TIMEOUT_MS", defaultRequestTimeoutMs)) * time.Millisecond,
		MetadataTTL:      time.Duration(readIntEnv("PACKAGE_NINJA_ARES_METADATA_TTL_MS", defaultMetadataTTLms)) * time.Millisecond,
		ShadowTargetURL:  strings.TrimRight(shadowTarget, "/"),
		ShadowTimeout:    time.Duration(readIntEnv("PACKAGE_NINJA_ARES_SHADOW_TIMEOUT_MS", defaultShadowTimeoutMs)) * time.Millisecond,
		EnableShadowMode: enableShadowMode,
		StrictParity:     strictParity,
		ParityReportPath: parityReportPath,
		ParityMaxEntries: readIntEnv("PACKAGE_NINJA_ARES_PARITY_MAX_ENTRIES", defaultParityEntries),
	}
}

func readEnv(name string, fallback string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}

	return value
}

func readIntEnv(name string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}

	parsed, err := strconv.Atoi(raw)
	if err != nil || parsed <= 0 {
		return fallback
	}

	return parsed
}

func readBoolEnv(name string, fallback bool) bool {
	raw := strings.TrimSpace(strings.ToLower(os.Getenv(name)))
	if raw == "" {
		return fallback
	}

	switch raw {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}
