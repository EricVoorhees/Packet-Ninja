package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"time"

	"package-ninja-ares/internal/collapse"
	"package-ninja-ares/internal/config"
	"package-ninja-ares/internal/parity"
	"package-ninja-ares/internal/state"
	"package-ninja-ares/internal/storage"
)

type Engine struct {
	cfg        config.Config
	logger     *log.Logger
	state      *state.Machine
	client     *http.Client
	tarballs   *storage.TarballStore
	metadata   *storage.MetadataCache
	tarFlight  *collapse.Coordinator
	metaFlight *collapse.Coordinator
	reporter   *parity.Reporter
	stats      *upstreamStats
}

func New(cfg config.Config, logger *log.Logger) (*Engine, error) {
	if logger == nil {
		logger = log.Default()
	}

	runtimeState := state.NewMachine()

	tarballStore, err := storage.NewTarballStore(cfg.DataDir)
	if err != nil {
		return nil, fmt.Errorf("tarball store init failed: %w", err)
	}

	metadataCache, err := storage.NewMetadataCache(cfg.DataDir)
	if err != nil {
		return nil, fmt.Errorf("metadata cache init failed: %w", err)
	}

	engine := &Engine{
		cfg:        cfg,
		logger:     logger,
		state:      runtimeState,
		client:     &http.Client{Timeout: cfg.RequestTimeout},
		tarballs:   tarballStore,
		metadata:   metadataCache,
		tarFlight:  collapse.NewCoordinator(),
		metaFlight: collapse.NewCoordinator(),
		reporter:   parity.NewReporter(cfg.ParityReportPath, cfg.ParityMaxEntries),
		stats:      newUpstreamStats(),
	}

	_ = engine.state.Transition(state.StateReady, "engine initialized")
	return engine, nil
}

func (e *Engine) Run(ctx context.Context) error {
	listener, err := net.Listen("tcp", e.cfg.ListenAddr)
	if err != nil {
		_ = e.state.Transition(state.StateDegraded, "listen failed")
		return err
	}

	httpServer := &http.Server{
		Handler:           e,
		ReadHeaderTimeout: 5 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		err := httpServer.Serve(listener)
		if err == nil || errors.Is(err, http.ErrServerClosed) {
			errCh <- nil
			return
		}

		errCh <- err
	}()

	select {
	case <-ctx.Done():
		_ = e.state.Transition(state.StateDraining, "context canceled")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
		_ = e.state.Transition(state.StateStopped, "shutdown complete")
		return nil
	case err := <-errCh:
		if err != nil {
			_ = e.state.Transition(state.StateDegraded, "serve failed")
			return err
		}
		_ = e.state.Transition(state.StateStopped, "server stopped")
		return nil
	}
}

func (e *Engine) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/-/health" {
		e.handleHealth(w)
		return
	}
	if r.URL.Path == "/-/stats" {
		e.handleStats(w)
		return
	}

	if isTarballPath(r.URL.EscapedPath()) {
		e.handleTarball(w, r)
		return
	}

	if isMetadataPath(r.URL.EscapedPath()) && r.Method == http.MethodGet {
		e.handleMetadata(w, r)
		return
	}

	e.proxyPassthrough(w, r)
}

func (e *Engine) handleHealth(w http.ResponseWriter) {
	payload := e.state.Snapshot()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = fmt.Fprintf(
		w,
		`{"state":"%s","reason":"%s","changedAt":"%s"}`,
		payload.State,
		escapeJSON(payload.Reason),
		payload.ChangedAt.Format(time.RFC3339Nano),
	)
}

func (e *Engine) handleStats(w http.ResponseWriter) {
	if e.stats == nil {
		http.Error(w, "stats unavailable", http.StatusServiceUnavailable)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	encoder := json.NewEncoder(w)
	encoder.SetIndent("", "  ")
	_ = encoder.Encode(e.stats.snapshot())
}

func (e *Engine) handleMetadata(w http.ResponseWriter, r *http.Request) {
	requestStarted := time.Now()
	key := "metadata:" + r.URL.RequestURI()
	entry, _, hasCache := e.metadata.Lookup(key)

	if hasCache && e.metadata.IsFresh(entry, e.cfg.MetadataTTL) {
		if err := e.serveCachedMetadataResponse(w, r, entry, requestStarted); err != nil {
			e.logger.Printf("metadata cache serve error: key=%s err=%v", key, err)
			http.Error(w, "metadata cache read failed", http.StatusInternalServerError)
		}
		return
	}

	leader, wait, done := e.metaFlight.Begin(key)
	if !leader {
		e.stats.recordMetadataFollower(r.URL.RequestURI())
		if err := wait(); err != nil {
			http.Error(w, "metadata fetch failed", http.StatusBadGateway)
			return
		}

		followerEntry, _, ok := e.metadata.Lookup(key)
		if !ok {
			http.Error(w, "metadata unavailable", http.StatusBadGateway)
			return
		}

		if serveErr := e.serveCachedMetadataResponse(w, r, followerEntry, requestStarted); serveErr != nil {
			http.Error(w, "metadata cache read failed", http.StatusInternalServerError)
			return
		}
		return
	}
	e.stats.recordMetadataLeader(r.URL.RequestURI())

	var leaderErr error
	defer func() {
		done(leaderErr)
	}()

	upstreamReq, err := e.newUpstreamRequest(r.Context(), r, nil)
	if err != nil {
		leaderErr = err
		http.Error(w, "upstream request build failed", http.StatusInternalServerError)
		return
	}
	// Persist plain JSON payloads in cache to avoid replaying compressed bodies without encoding headers.
	upstreamReq.Header.Set("Accept-Encoding", "identity")

	if hasCache {
		if entry.ETag != "" {
			upstreamReq.Header.Set("If-None-Match", entry.ETag)
		}
		if entry.LastModified != "" {
			upstreamReq.Header.Set("If-Modified-Since", entry.LastModified)
		}
	}

	e.stats.recordMetadataUpstream(r.URL.RequestURI())
	resp, err := e.client.Do(upstreamReq)
	if err != nil {
		leaderErr = err
		http.Error(w, "metadata upstream request failed", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	body, readErr := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if readErr != nil {
		leaderErr = readErr
		http.Error(w, "metadata read failed", http.StatusBadGateway)
		return
	}

	if resp.StatusCode == http.StatusNotModified && hasCache {
		if serveErr := e.serveCachedMetadataResponse(w, r, entry, requestStarted); serveErr != nil {
			leaderErr = serveErr
			http.Error(w, "metadata cache read failed", http.StatusInternalServerError)
		}
		return
	}

	aresTTFB := time.Since(requestStarted)
	if parityErr := e.checkMetadataParity(r, resp.StatusCode, body, aresTTFB); parityErr != nil {
		leaderErr = parityErr
		http.Error(w, "metadata parity strict check failed", http.StatusBadGateway)
		return
	}

	if resp.StatusCode != http.StatusOK {
		copyResponseHeaders(w.Header(), resp.Header)
		w.WriteHeader(resp.StatusCode)
		_, leaderErr = w.Write(body)
		return
	}

	meta := storage.MetadataMeta{
		ETag:         resp.Header.Get("ETag"),
		LastModified: resp.Header.Get("Last-Modified"),
		ContentType:  firstNonEmpty(resp.Header.Get("Content-Type"), "application/json"),
	}
	if _, saveErr := e.metadata.Save(key, body, meta); saveErr != nil {
		leaderErr = saveErr
		http.Error(w, "metadata cache write failed", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", meta.ContentType)
	if meta.ETag != "" {
		w.Header().Set("ETag", meta.ETag)
	}
	if meta.LastModified != "" {
		w.Header().Set("Last-Modified", meta.LastModified)
	}
	w.WriteHeader(http.StatusOK)
	_, leaderErr = w.Write(body)
}

func (e *Engine) serveCachedMetadataResponse(
	w http.ResponseWriter,
	r *http.Request,
	entry storage.MetadataEntry,
	requestStarted time.Time,
) error {
	lookupEntry, body, ok := e.metadata.Lookup(entry.Key)
	if !ok {
		return errors.New("cached metadata not found")
	}

	entry = lookupEntry
	statusCode := http.StatusOK
	responseBody := body
	if entry.ETag != "" && r.Header.Get("If-None-Match") == entry.ETag {
		statusCode = http.StatusNotModified
		responseBody = nil
	}

	if parityErr := e.checkMetadataParity(r, statusCode, responseBody, time.Since(requestStarted)); parityErr != nil {
		return parityErr
	}

	if entry.ContentType != "" {
		w.Header().Set("Content-Type", entry.ContentType)
	} else {
		w.Header().Set("Content-Type", "application/json")
	}
	if entry.ETag != "" {
		w.Header().Set("ETag", entry.ETag)
	}
	if entry.LastModified != "" {
		w.Header().Set("Last-Modified", entry.LastModified)
	}

	w.WriteHeader(statusCode)
	if statusCode == http.StatusNotModified || len(responseBody) == 0 {
		return nil
	}

	_, err := w.Write(responseBody)
	return err
}

type metadataProbeRequest struct {
	method     string
	requestURI string
	headers    http.Header
}

func (e *Engine) checkMetadataParity(r *http.Request, aresStatus int, aresBody []byte, aresTTFB time.Duration) error {
	if !e.cfg.EnableShadowMode || strings.TrimSpace(e.cfg.ShadowTargetURL) == "" {
		return nil
	}

	request := metadataProbeRequest{
		method:     r.Method,
		requestURI: r.URL.RequestURI(),
		headers:    r.Header.Clone(),
	}

	if e.cfg.StrictParity {
		entry := e.runMetadataParityProbe(request, aresStatus, aresBody, aresTTFB)
		e.appendParityEntry(entry)
		if entry.StrictViolation {
			return fmt.Errorf("shadow parity mismatch for %s", request.requestURI)
		}
		return nil
	}

	bodyCopy := append([]byte(nil), aresBody...)
	go func() {
		entry := e.runMetadataParityProbe(request, aresStatus, bodyCopy, aresTTFB)
		e.appendParityEntry(entry)
	}()
	return nil
}

func (e *Engine) runMetadataParityProbe(
	request metadataProbeRequest,
	aresStatus int,
	aresBody []byte,
	aresTTFB time.Duration,
) parity.ReportEntry {
	reportEntry := parity.ReportEntry{
		Timestamp:     time.Now().UTC().Format(time.RFC3339Nano),
		Method:        request.method,
		Path:          request.requestURI,
		AresStatus:    aresStatus,
		AresTTFBMs:    durationToMilliseconds(aresTTFB),
		AresBodyBytes: len(aresBody),
		Result:        parity.ResultMatch,
	}

	timeout := e.cfg.ShadowTimeout
	if timeout <= 0 {
		timeout = 2 * time.Second
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	target := e.cfg.ShadowTargetURL + request.requestURI
	shadowReq, err := http.NewRequestWithContext(ctx, request.method, target, nil)
	if err != nil {
		reportEntry.Result = parity.ResultError
		reportEntry.StrictViolation = true
		reportEntry.Error = fmt.Sprintf("shadow request build failed: %v", err)
		return reportEntry
	}

	shadowReq.Header = request.headers.Clone()
	shadowReq.Header.Set("Accept-Encoding", "identity")
	shadowReq.Host = ""

	shadowStarted := time.Now()
	shadowResp, err := e.client.Do(shadowReq)
	if err != nil {
		reportEntry.Result = parity.ResultError
		reportEntry.StrictViolation = true
		reportEntry.Error = fmt.Sprintf("shadow request failed: %v", err)
		return reportEntry
	}
	defer shadowResp.Body.Close()

	reportEntry.ShadowTTFBMs = durationToMilliseconds(time.Since(shadowStarted))
	reportEntry.ShadowStatus = shadowResp.StatusCode

	shadowBody, readErr := io.ReadAll(io.LimitReader(shadowResp.Body, 64<<20))
	if readErr != nil {
		reportEntry.Result = parity.ResultError
		reportEntry.StrictViolation = true
		reportEntry.Error = fmt.Sprintf("shadow body read failed: %v", readErr)
		return reportEntry
	}
	reportEntry.ShadowBodyBytes = len(shadowBody)

	if aresStatus != shadowResp.StatusCode {
		reportEntry.Result = parity.ResultMismatch
		reportEntry.StrictViolation = true
		reportEntry.Error = fmt.Sprintf("status mismatch: ares=%d shadow=%d", aresStatus, shadowResp.StatusCode)
		return reportEntry
	}

	if aresStatus == http.StatusNotModified {
		return reportEntry
	}

	if aresStatus != http.StatusOK {
		if bytes.Equal(bytes.TrimSpace(aresBody), bytes.TrimSpace(shadowBody)) {
			return reportEntry
		}

		reportEntry.Result = parity.ResultMismatch
		reportEntry.StrictViolation = true
		reportEntry.Error = "non-200 body mismatch"
		return reportEntry
	}

	diff, diffErr := parity.CompareMetadataJSON(aresBody, shadowBody, 40)
	if diffErr != nil {
		reportEntry.Result = parity.ResultError
		reportEntry.StrictViolation = true
		reportEntry.Error = diffErr.Error()
		return reportEntry
	}

	if diff.Equal {
		return reportEntry
	}

	reportEntry.Result = parity.ResultMismatch
	reportEntry.StrictViolation = true
	reportEntry.Diff = &diff
	reportEntry.Error = "metadata body mismatch"
	return reportEntry
}

func (e *Engine) appendParityEntry(entry parity.ReportEntry) {
	if e.reporter == nil {
		return
	}

	if err := e.reporter.Append(entry); err != nil {
		e.logger.Printf("parity report append error: path=%s err=%v", entry.Path, err)
	}
}

func durationToMilliseconds(value time.Duration) float64 {
	return float64(value.Microseconds()) / 1000.0
}

func (e *Engine) handleTarball(w http.ResponseWriter, r *http.Request) {
	key := "tarball:" + r.URL.RequestURI()

	served, err := e.tarballs.ServeIfPresent(w, r, key)
	if err != nil {
		http.Error(w, "tarball cache read failed", http.StatusInternalServerError)
		return
	}
	if served {
		return
	}

	leader, wait, done := e.tarFlight.Begin(key)
	if !leader {
		e.stats.recordTarballFollower(r.URL.RequestURI())
		if waitErr := wait(); waitErr != nil {
			http.Error(w, "tarball fetch failed", http.StatusBadGateway)
			return
		}

		cached, cachedErr := e.tarballs.ServeIfPresent(w, r, key)
		if cachedErr != nil {
			http.Error(w, "tarball cache read failed", http.StatusInternalServerError)
			return
		}
		if cached {
			return
		}

		http.Error(w, "tarball unavailable", http.StatusBadGateway)
		return
	}
	e.stats.recordTarballLeader(r.URL.RequestURI())

	var leaderErr error
	defer func() {
		done(leaderErr)
	}()

	upstreamReq, err := e.newUpstreamRequest(r.Context(), r, nil)
	if err != nil {
		leaderErr = err
		http.Error(w, "upstream request build failed", http.StatusInternalServerError)
		return
	}

	e.stats.recordTarballUpstream(r.URL.RequestURI())
	resp, err := e.client.Do(upstreamReq)
	if err != nil {
		leaderErr = err
		http.Error(w, "tarball upstream request failed", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	e.shadowProbe(r)

	if resp.StatusCode != http.StatusOK {
		copyResponseHeaders(w.Header(), resp.Header)
		w.WriteHeader(resp.StatusCode)
		_, copyErr := io.Copy(w, resp.Body)
		if copyErr != nil {
			leaderErr = copyErr
		}
		return
	}

	copyResponseHeaders(w.Header(), resp.Header)
	w.WriteHeader(http.StatusOK)
	_, leaderErr = e.tarballs.StreamAndCache(key, resp.Body, w, storage.TarballMeta{
		ETag:         resp.Header.Get("ETag"),
		LastModified: resp.Header.Get("Last-Modified"),
		ContentType:  resp.Header.Get("Content-Type"),
	})
}

func (e *Engine) proxyPassthrough(w http.ResponseWriter, r *http.Request) {
	upstreamReq, err := e.newUpstreamRequest(r.Context(), r, r.Body)
	if err != nil {
		http.Error(w, "upstream request build failed", http.StatusInternalServerError)
		return
	}

	e.stats.recordPassthroughUpstream(r.URL.RequestURI())
	resp, err := e.client.Do(upstreamReq)
	if err != nil {
		http.Error(w, "upstream request failed", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	e.shadowProbe(r)

	copyResponseHeaders(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func (e *Engine) newUpstreamRequest(ctx context.Context, r *http.Request, body io.Reader) (*http.Request, error) {
	targetURL := e.cfg.UpstreamURL + r.URL.RequestURI()
	request, err := http.NewRequestWithContext(ctx, r.Method, targetURL, body)
	if err != nil {
		return nil, err
	}

	request.Header = r.Header.Clone()
	request.Host = ""
	return request, nil
}

func (e *Engine) shadowProbe(r *http.Request) {
	if !e.cfg.EnableShadowMode || strings.TrimSpace(e.cfg.ShadowTargetURL) == "" {
		return
	}

	method := r.Method
	target := e.cfg.ShadowTargetURL + r.URL.RequestURI()
	timeout := e.cfg.ShadowTimeout
	if timeout <= 0 {
		timeout = 2 * time.Second
	}

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()

		req, err := http.NewRequestWithContext(ctx, method, target, nil)
		if err != nil {
			return
		}

		resp, err := e.client.Do(req)
		if err != nil {
			e.logger.Printf("shadow probe error: method=%s target=%s err=%v", method, target, err)
			return
		}
		_ = resp.Body.Close()
	}()
}

func copyResponseHeaders(dst http.Header, src http.Header) {
	for key := range dst {
		dst.Del(key)
	}

	for key, values := range src {
		for _, value := range values {
			dst.Add(key, value)
		}
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed != "" {
			return trimmed
		}
	}

	return ""
}

func isTarballPath(requestPath string) bool {
	return strings.Contains(requestPath, "/-/") && strings.HasSuffix(strings.ToLower(requestPath), ".tgz")
}

func isMetadataPath(requestPath string) bool {
	trimmed := strings.TrimPrefix(requestPath, "/")
	if trimmed == "" {
		return false
	}

	if strings.HasPrefix(trimmed, "-/") {
		return false
	}

	if strings.Contains(trimmed, "/-/") {
		return false
	}

	// Scoped packages may include a slash, otherwise metadata requests are typically single-segment.
	return strings.Count(trimmed, "/") <= 1
}

func escapeJSON(input string) string {
	replacer := strings.NewReplacer(
		`\\`, `\\\\`,
		`"`, `\"`,
		"\n", `\n`,
		"\r", `\r`,
		"\t", `\t`,
	)

	return replacer.Replace(input)
}
