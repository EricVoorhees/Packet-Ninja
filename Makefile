ifeq ($(OS),Windows_NT)
  BIN_EXT := .exe
else
  BIN_EXT :=
endif

.PHONY: build-go build-go-worker build-go-entry build-go-ares test-go-ares clean-go

build-go: build-go-worker build-go-entry build-go-ares

build-go-worker:
	go build -C go/command-worker -o ../../bin/command-worker-go$(BIN_EXT) .

build-go-entry:
	go build -C go/ninja -o ../../bin/ninja$(BIN_EXT) .

build-go-ares:
	go build -C go/ares -o ../../bin/ares-registry$(BIN_EXT) ./cmd/ares-registry

test-go-ares:
	go test -C go/ares ./...

clean-go:
	rm -f bin/command-worker-go bin/command-worker-go.exe bin/ninja bin/ninja.exe bin/ares-registry bin/ares-registry.exe
