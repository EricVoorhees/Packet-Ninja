package state

import (
	"errors"
	"fmt"
	"sync"
	"time"
)

type RuntimeState string

const (
	StateBooting  RuntimeState = "booting"
	StateReady    RuntimeState = "ready"
	StateDegraded RuntimeState = "degraded"
	StateDraining RuntimeState = "draining"
	StateStopped  RuntimeState = "stopped"
)

type Snapshot struct {
	State     RuntimeState `json:"state"`
	Reason    string       `json:"reason,omitempty"`
	ChangedAt time.Time    `json:"changedAt"`
}

type Machine struct {
	mu      sync.RWMutex
	current RuntimeState
	reason  string
	at      time.Time
}

func NewMachine() *Machine {
	return &Machine{
		current: StateBooting,
		reason:  "initializing",
		at:      time.Now().UTC(),
	}
}

func (m *Machine) Snapshot() Snapshot {
	m.mu.RLock()
	defer m.mu.RUnlock()

	return Snapshot{
		State:     m.current,
		Reason:    m.reason,
		ChangedAt: m.at,
	}
}

func (m *Machine) Transition(next RuntimeState, reason string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if next == "" {
		return errors.New("next state is required")
	}

	if m.current == next {
		m.reason = reason
		m.at = time.Now().UTC()
		return nil
	}

	if !canTransition(m.current, next) {
		return fmt.Errorf("invalid transition %s -> %s", m.current, next)
	}

	m.current = next
	m.reason = reason
	m.at = time.Now().UTC()
	return nil
}

func canTransition(current RuntimeState, next RuntimeState) bool {
	switch current {
	case StateBooting:
		return next == StateReady || next == StateDegraded || next == StateStopped
	case StateReady:
		return next == StateDegraded || next == StateDraining
	case StateDegraded:
		return next == StateReady || next == StateDraining
	case StateDraining:
		return next == StateStopped
	case StateStopped:
		return false
	default:
		return false
	}
}
