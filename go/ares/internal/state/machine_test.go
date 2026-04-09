package state

import "testing"

func TestValidTransitionSequence(t *testing.T) {
	m := NewMachine()

	if err := m.Transition(StateReady, "startup complete"); err != nil {
		t.Fatalf("transition to ready failed: %v", err)
	}

	if err := m.Transition(StateDegraded, "upstream timeout"); err != nil {
		t.Fatalf("transition to degraded failed: %v", err)
	}

	if err := m.Transition(StateReady, "upstream healthy"); err != nil {
		t.Fatalf("transition back to ready failed: %v", err)
	}

	if err := m.Transition(StateDraining, "shutdown requested"); err != nil {
		t.Fatalf("transition to draining failed: %v", err)
	}

	if err := m.Transition(StateStopped, "shutdown complete"); err != nil {
		t.Fatalf("transition to stopped failed: %v", err)
	}
}

func TestRejectInvalidTransition(t *testing.T) {
	m := NewMachine()

	if err := m.Transition(StateDraining, "invalid early drain"); err == nil {
		t.Fatalf("expected invalid transition error")
	}
}
