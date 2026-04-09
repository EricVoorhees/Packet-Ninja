package collapse

import (
	"errors"
	"testing"
)

func TestCoordinatorCollapsesFollowers(t *testing.T) {
	c := NewCoordinator()
	leader, wait, done := c.Begin("metadata:react")
	if !leader || wait != nil || done == nil {
		t.Fatalf("expected first caller to be leader")
	}

	followerLeader, followerWait, followerDone := c.Begin("metadata:react")
	if followerLeader {
		t.Fatalf("expected follower caller")
	}
	if followerDone != nil {
		t.Fatalf("expected follower done to be nil")
	}
	if followerWait == nil {
		t.Fatalf("expected follower wait function")
	}

	done(nil)
	if err := followerWait(); err != nil {
		t.Fatalf("expected follower success, got %v", err)
	}
}

func TestCoordinatorPropagatesLeaderError(t *testing.T) {
	c := NewCoordinator()
	_, _, done := c.Begin("tarball:/foo.tgz")
	_, followerWait, _ := c.Begin("tarball:/foo.tgz")

	expected := errors.New("upstream failed")
	done(expected)

	if err := followerWait(); !errors.Is(err, expected) {
		t.Fatalf("expected follower error %v, got %v", expected, err)
	}
}
