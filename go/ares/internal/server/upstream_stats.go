package server

import (
	"sync"
	"sync/atomic"
	"time"
)

type upstreamStats struct {
	startedAt time.Time

	metadataUpstream    atomic.Uint64
	tarballUpstream     atomic.Uint64
	passthroughUpstream atomic.Uint64

	metadataLeaders   atomic.Uint64
	metadataFollowers atomic.Uint64
	tarballLeaders    atomic.Uint64
	tarballFollowers  atomic.Uint64

	mu                     sync.Mutex
	metadataByPath         map[string]uint64
	tarballByPath          map[string]uint64
	passthroughByPath      map[string]uint64
	metadataFollowerByPath map[string]uint64
	tarballFollowerByPath  map[string]uint64
}

type upstreamStatsSnapshot struct {
	StartedAt string `json:"startedAt"`
	Totals    struct {
		Metadata    uint64 `json:"metadata"`
		Tarball     uint64 `json:"tarball"`
		Passthrough uint64 `json:"passthrough"`
		Overall     uint64 `json:"overall"`
	} `json:"totals"`
	Collapse struct {
		MetadataLeaders   uint64 `json:"metadataLeaders"`
		MetadataFollowers uint64 `json:"metadataFollowers"`
		TarballLeaders    uint64 `json:"tarballLeaders"`
		TarballFollowers  uint64 `json:"tarballFollowers"`
	} `json:"collapse"`
	Paths struct {
		Metadata          map[string]uint64 `json:"metadata"`
		Tarball           map[string]uint64 `json:"tarball"`
		Passthrough       map[string]uint64 `json:"passthrough"`
		MetadataFollowers map[string]uint64 `json:"metadataFollowers"`
		TarballFollowers  map[string]uint64 `json:"tarballFollowers"`
	} `json:"paths"`
}

func newUpstreamStats() *upstreamStats {
	return &upstreamStats{
		startedAt:              time.Now().UTC(),
		metadataByPath:         make(map[string]uint64),
		tarballByPath:          make(map[string]uint64),
		passthroughByPath:      make(map[string]uint64),
		metadataFollowerByPath: make(map[string]uint64),
		tarballFollowerByPath:  make(map[string]uint64),
	}
}

func (s *upstreamStats) recordMetadataLeader(path string) {
	s.metadataLeaders.Add(1)
}

func (s *upstreamStats) recordMetadataFollower(path string) {
	s.metadataFollowers.Add(1)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.metadataFollowerByPath[path] += 1
}

func (s *upstreamStats) recordTarballLeader(path string) {
	s.tarballLeaders.Add(1)
}

func (s *upstreamStats) recordTarballFollower(path string) {
	s.tarballFollowers.Add(1)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tarballFollowerByPath[path] += 1
}

func (s *upstreamStats) recordMetadataUpstream(path string) {
	s.metadataUpstream.Add(1)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.metadataByPath[path] += 1
}

func (s *upstreamStats) recordTarballUpstream(path string) {
	s.tarballUpstream.Add(1)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tarballByPath[path] += 1
}

func (s *upstreamStats) recordPassthroughUpstream(path string) {
	s.passthroughUpstream.Add(1)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.passthroughByPath[path] += 1
}

func (s *upstreamStats) snapshot() upstreamStatsSnapshot {
	metadataTotal := s.metadataUpstream.Load()
	tarballTotal := s.tarballUpstream.Load()
	passthroughTotal := s.passthroughUpstream.Load()

	s.mu.Lock()
	defer s.mu.Unlock()

	var snapshot upstreamStatsSnapshot
	snapshot.StartedAt = s.startedAt.Format(time.RFC3339Nano)
	snapshot.Totals.Metadata = metadataTotal
	snapshot.Totals.Tarball = tarballTotal
	snapshot.Totals.Passthrough = passthroughTotal
	snapshot.Totals.Overall = metadataTotal + tarballTotal + passthroughTotal

	snapshot.Collapse.MetadataLeaders = s.metadataLeaders.Load()
	snapshot.Collapse.MetadataFollowers = s.metadataFollowers.Load()
	snapshot.Collapse.TarballLeaders = s.tarballLeaders.Load()
	snapshot.Collapse.TarballFollowers = s.tarballFollowers.Load()

	snapshot.Paths.Metadata = cloneCountMap(s.metadataByPath)
	snapshot.Paths.Tarball = cloneCountMap(s.tarballByPath)
	snapshot.Paths.Passthrough = cloneCountMap(s.passthroughByPath)
	snapshot.Paths.MetadataFollowers = cloneCountMap(s.metadataFollowerByPath)
	snapshot.Paths.TarballFollowers = cloneCountMap(s.tarballFollowerByPath)

	return snapshot
}

func cloneCountMap(input map[string]uint64) map[string]uint64 {
	output := make(map[string]uint64, len(input))
	for key, value := range input {
		output[key] = value
	}
	return output
}
