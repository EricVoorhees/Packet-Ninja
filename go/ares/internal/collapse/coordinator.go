package collapse

import "sync"

type Coordinator struct {
	mu      sync.Mutex
	flights map[string]*flight
}

type flight struct {
	done chan struct{}
	err  error
}

func NewCoordinator() *Coordinator {
	return &Coordinator{
		flights: make(map[string]*flight),
	}
}

func (c *Coordinator) Begin(key string) (leader bool, wait func() error, done func(err error)) {
	c.mu.Lock()
	if existing, ok := c.flights[key]; ok {
		c.mu.Unlock()
		return false, func() error {
			<-existing.done
			return existing.err
		}, nil
	}

	current := &flight{
		done: make(chan struct{}),
	}
	c.flights[key] = current
	c.mu.Unlock()

	return true, nil, func(err error) {
		c.mu.Lock()
		defer c.mu.Unlock()

		if active, ok := c.flights[key]; ok && active == current {
			active.err = err
			close(active.done)
			delete(c.flights, key)
		}
	}
}
