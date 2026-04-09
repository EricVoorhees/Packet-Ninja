package server

import "testing"

func TestUpstreamStatsSnapshot(t *testing.T) {
	stats := newUpstreamStats()

	stats.recordMetadataLeader("/lodash")
	stats.recordMetadataFollower("/lodash")
	stats.recordMetadataFollower("/lodash")
	stats.recordMetadataUpstream("/lodash")
	stats.recordMetadataUpstream("/lodash")

	stats.recordTarballLeader("/lodash/-/lodash-4.17.21.tgz")
	stats.recordTarballFollower("/lodash/-/lodash-4.17.21.tgz")
	stats.recordTarballUpstream("/lodash/-/lodash-4.17.21.tgz")

	stats.recordPassthroughUpstream("/-/v1/search?text=lodash")

	snapshot := stats.snapshot()

	if snapshot.Totals.Metadata != 2 {
		t.Fatalf("expected metadata total 2, got %d", snapshot.Totals.Metadata)
	}
	if snapshot.Totals.Tarball != 1 {
		t.Fatalf("expected tarball total 1, got %d", snapshot.Totals.Tarball)
	}
	if snapshot.Totals.Passthrough != 1 {
		t.Fatalf("expected passthrough total 1, got %d", snapshot.Totals.Passthrough)
	}
	if snapshot.Totals.Overall != 4 {
		t.Fatalf("expected overall total 4, got %d", snapshot.Totals.Overall)
	}
	if snapshot.Collapse.MetadataLeaders != 1 {
		t.Fatalf("expected metadata leaders 1, got %d", snapshot.Collapse.MetadataLeaders)
	}
	if snapshot.Collapse.MetadataFollowers != 2 {
		t.Fatalf("expected metadata followers 2, got %d", snapshot.Collapse.MetadataFollowers)
	}
	if snapshot.Collapse.TarballLeaders != 1 {
		t.Fatalf("expected tarball leaders 1, got %d", snapshot.Collapse.TarballLeaders)
	}
	if snapshot.Collapse.TarballFollowers != 1 {
		t.Fatalf("expected tarball followers 1, got %d", snapshot.Collapse.TarballFollowers)
	}
	if snapshot.Paths.Metadata["/lodash"] != 2 {
		t.Fatalf("expected metadata path count 2, got %d", snapshot.Paths.Metadata["/lodash"])
	}
	if snapshot.Paths.MetadataFollowers["/lodash"] != 2 {
		t.Fatalf("expected metadata follower path count 2, got %d", snapshot.Paths.MetadataFollowers["/lodash"])
	}
	if snapshot.Paths.Tarball["/lodash/-/lodash-4.17.21.tgz"] != 1 {
		t.Fatalf("expected tarball path count 1, got %d", snapshot.Paths.Tarball["/lodash/-/lodash-4.17.21.tgz"])
	}
	if snapshot.Paths.Passthrough["/-/v1/search?text=lodash"] != 1 {
		t.Fatalf("expected passthrough path count 1, got %d", snapshot.Paths.Passthrough["/-/v1/search?text=lodash"])
	}
}
