ifeq ($(OS),Windows_NT)
  BIN_EXT := .exe
else
  BIN_EXT :=
endif

.PHONY: build-go build-go-worker build-go-entry clean-go

build-go: build-go-worker build-go-entry

build-go-worker:
	go build -C go/command-worker -o ../../bin/command-worker-go$(BIN_EXT) .

build-go-entry:
	go build -C go/ninja -o ../../bin/ninja$(BIN_EXT) .

clean-go:
	rm -f bin/command-worker-go bin/command-worker-go.exe bin/ninja bin/ninja.exe

