package parity

import (
	"bytes"
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strings"
)

const (
	defaultMaxDifferences = 30
	maxValuePreviewLength = 240
)

type Difference struct {
	Path   string `json:"path"`
	Kind   string `json:"kind"`
	Ares   string `json:"ares,omitempty"`
	Shadow string `json:"shadow,omitempty"`
}

type MetadataDiff struct {
	Equal                 bool         `json:"equal"`
	MissingFieldCount     int          `json:"missingFieldCount"`
	VersionMismatchCount  int          `json:"versionMismatchCount"`
	ChecksumMismatchCount int          `json:"checksumMismatchCount"`
	Differences           []Difference `json:"differences,omitempty"`
	Truncated             bool         `json:"truncated,omitempty"`
}

func CompareMetadataJSON(aresBody []byte, shadowBody []byte, maxDifferences int) (MetadataDiff, error) {
	if maxDifferences <= 0 {
		maxDifferences = defaultMaxDifferences
	}

	aresValue, err := decodeJSON(aresBody)
	if err != nil {
		return MetadataDiff{}, fmt.Errorf("ares metadata decode failed: %w", err)
	}

	shadowValue, err := decodeJSON(shadowBody)
	if err != nil {
		return MetadataDiff{}, fmt.Errorf("shadow metadata decode failed: %w", err)
	}

	accumulator := &diffAccumulator{
		maxDifferences: maxDifferences,
	}
	accumulator.compare("", aresValue, shadowValue)

	result := MetadataDiff{
		Equal:                 len(accumulator.differences) == 0,
		MissingFieldCount:     accumulator.missingFieldCount,
		VersionMismatchCount:  accumulator.versionMismatchCount,
		ChecksumMismatchCount: accumulator.checksumMismatchCount,
		Differences:           accumulator.differences,
		Truncated:             accumulator.truncated,
	}
	return result, nil
}

type diffAccumulator struct {
	maxDifferences        int
	differences           []Difference
	missingFieldCount     int
	versionMismatchCount  int
	checksumMismatchCount int
	truncated             bool
}

func (d *diffAccumulator) compare(path string, ares any, shadow any) {
	if d.reachedLimit() {
		return
	}

	if aresMap, ok := ares.(map[string]any); ok {
		shadowMap, shadowOK := shadow.(map[string]any)
		if !shadowOK {
			d.record(path, "type_mismatch", ares, shadow)
			return
		}

		keys := unionKeys(aresMap, shadowMap)
		for _, key := range keys {
			aresValue, aresExists := aresMap[key]
			shadowValue, shadowExists := shadowMap[key]
			childPath := joinPath(path, key)

			if !aresExists {
				d.record(childPath, "missing_in_ares", nil, shadowValue)
				continue
			}
			if !shadowExists {
				d.record(childPath, "missing_in_shadow", aresValue, nil)
				continue
			}

			d.compare(childPath, aresValue, shadowValue)
			if d.reachedLimit() {
				return
			}
		}
		return
	}

	if aresSlice, ok := ares.([]any); ok {
		shadowSlice, shadowOK := shadow.([]any)
		if !shadowOK {
			d.record(path, "type_mismatch", ares, shadow)
			return
		}

		limit := len(aresSlice)
		if len(shadowSlice) > limit {
			limit = len(shadowSlice)
		}

		for index := 0; index < limit; index += 1 {
			childPath := joinArrayPath(path, index)
			if index >= len(aresSlice) {
				d.record(childPath, "missing_in_ares", nil, shadowSlice[index])
				continue
			}
			if index >= len(shadowSlice) {
				d.record(childPath, "missing_in_shadow", aresSlice[index], nil)
				continue
			}

			d.compare(childPath, aresSlice[index], shadowSlice[index])
			if d.reachedLimit() {
				return
			}
		}
		return
	}

	if !scalarEqual(ares, shadow) {
		d.record(path, "value_mismatch", ares, shadow)
	}
}

func (d *diffAccumulator) record(path string, kind string, ares any, shadow any) {
	if d.reachedLimit() {
		return
	}

	normalizedPath := path
	if normalizedPath == "" {
		normalizedPath = "$"
	}

	if kind == "missing_in_ares" || kind == "missing_in_shadow" {
		d.missingFieldCount += 1
	}
	if isVersionPath(normalizedPath) {
		d.versionMismatchCount += 1
	}
	if isChecksumPath(normalizedPath) {
		d.checksumMismatchCount += 1
	}

	d.differences = append(d.differences, Difference{
		Path:   normalizedPath,
		Kind:   kind,
		Ares:   previewValue(ares),
		Shadow: previewValue(shadow),
	})
}

func (d *diffAccumulator) reachedLimit() bool {
	if len(d.differences) < d.maxDifferences {
		return false
	}

	d.truncated = true
	return true
}

func decodeJSON(payload []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.UseNumber()

	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	return value, nil
}

func unionKeys(a map[string]any, b map[string]any) []string {
	combined := make(map[string]struct{}, len(a)+len(b))
	for key := range a {
		combined[key] = struct{}{}
	}
	for key := range b {
		combined[key] = struct{}{}
	}

	keys := make([]string, 0, len(combined))
	for key := range combined {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func joinPath(base string, child string) string {
	if base == "" {
		return child
	}
	return base + "." + child
}

func joinArrayPath(base string, index int) string {
	if base == "" {
		return fmt.Sprintf("[%d]", index)
	}
	return fmt.Sprintf("%s[%d]", base, index)
}

func scalarEqual(a any, b any) bool {
	aNumber, aIsNumber := a.(json.Number)
	bNumber, bIsNumber := b.(json.Number)
	if aIsNumber && bIsNumber {
		return aNumber.String() == bNumber.String()
	}

	return reflect.DeepEqual(a, b)
}

func previewValue(value any) string {
	if value == nil {
		return "null"
	}

	encoded, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprintf("%v", value)
	}

	if len(encoded) <= maxValuePreviewLength {
		return string(encoded)
	}

	return string(encoded[:maxValuePreviewLength]) + "...(truncated)"
}

func isVersionPath(path string) bool {
	normalized := strings.ToLower(path)
	return strings.HasPrefix(normalized, "versions.") || strings.Contains(normalized, ".versions.")
}

func isChecksumPath(path string) bool {
	normalized := strings.ToLower(path)
	return strings.Contains(normalized, "integrity") ||
		strings.Contains(normalized, "shasum") ||
		strings.Contains(normalized, "checksum")
}
