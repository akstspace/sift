package sift

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	_ "golang.org/x/image/webp"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

type Storage struct {
	mu       sync.RWMutex
	Client   *minio.Client
	cmd      *exec.Cmd
	Error    string
	Ready    bool
	endpoint string
	dir      string
	wait     chan error
}

func (st *Storage) Start(ctx context.Context, dir string) error {
	dir, err := filepath.Abs(dir)
	if err != nil {
		return err
	}
	st.dir = dir
	binary := os.Getenv("SIFT_RUSTFS")
	if binary == "" {
		name := "rustfs-" + runtime.GOOS + "-" + runtime.GOARCH
		b, err := payload.ReadFile("payload/" + name)
		if err != nil {
			return fmt.Errorf("Bundled RustFS is missing for %s/%s; run scripts/prepare-rustfs.py", runtime.GOOS, runtime.GOARCH)
		}
		cache := filepath.Join(dir, "runtime", "rustfs-1.0.4")
		_ = os.MkdirAll(cache, 0700)
		binary = filepath.Join(cache, name)
		existing, _ := os.ReadFile(binary)
		if sha256.Sum256(existing) != sha256.Sum256(b) {
			if err = os.WriteFile(binary+".new", b, 0700); err != nil {
				return err
			}
			if err = os.Rename(binary+".new", binary); err != nil {
				return err
			}
		}
	}
	secretPath := filepath.Join(dir, "rustfs-secret")
	secret, err := os.ReadFile(secretPath)
	if os.IsNotExist(err) {
		secret = []byte(newID(""))
		err = os.WriteFile(secretPath, secret, 0600)
	}
	if err != nil {
		return err
	}
	_ = os.Chmod(secretPath, 0600)
	if err = os.MkdirAll(filepath.Join(dir, "objects"), 0700); err != nil {
		return err
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	st.endpoint = l.Addr().String()
	_ = l.Close()
	// RustFS 1.0.4 splits whitespace inside absolute volume arguments, including
	// macOS's default Application Support path. Keep the same on-disk volume,
	// but resolve it relative to the child's workspace instead of passing it.
	if !filepath.IsAbs(binary) && strings.ContainsRune(binary, os.PathSeparator) {
		binary, err = filepath.Abs(binary)
		if err != nil {
			return err
		}
	}
	st.cmd = exec.Command(binary, "server", "--address", st.endpoint, "objects")
	st.cmd.Dir = dir
	st.cmd.Env = append(os.Environ(), "RUSTFS_ACCESS_KEY=sift-local", "RUSTFS_SECRET_KEY_FILE="+secretPath, "RUSTFS_CONSOLE_ENABLE=false")
	log, err := os.OpenFile(filepath.Join(dir, "rustfs.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	st.cmd.Stdout = log
	st.cmd.Stderr = log
	if err = st.cmd.Start(); err != nil {
		log.Close()
		return err
	}
	st.wait = make(chan error, 1)
	go func() {
		e := st.cmd.Wait()
		log.Close()
		st.mu.Lock()
		st.Ready = false
		if e != nil {
			st.Error = "RustFS stopped unexpectedly; restart Sift"
		}
		st.mu.Unlock()
		st.wait <- e
		close(st.wait)
	}()
	client, err := minio.New(st.endpoint, &minio.Options{Creds: credentials.NewStaticV4("sift-local", trim(string(secret)), ""), Secure: false})
	if err != nil {
		return err
	}
	st.mu.Lock()
	st.Client = client
	st.mu.Unlock()
	deadline := time.Now().Add(45 * time.Second)
	hc := &http.Client{Timeout: time.Second}
	for time.Now().Before(deadline) {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		r, e := hc.Get("http://" + st.endpoint + "/health/ready")
		if e == nil {
			_ = r.Body.Close()
			if r.StatusCode == 200 {
				check, cancel := context.WithTimeout(ctx, 3*time.Second)
				exists, e := client.BucketExists(check, "sift")
				if e == nil && !exists {
					e = client.MakeBucket(check, "sift", minio.MakeBucketOptions{})
				}
				cancel()
				if e == nil {
					st.mu.Lock()
					st.Ready = true
					st.Error = ""
					st.mu.Unlock()
					return nil
				}
			}
		}
		select {
		case e := <-st.wait:
			return fmt.Errorf("RustFS exited: %v; inspect %s", e, filepath.Join(dir, "rustfs.log"))
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(300 * time.Millisecond):
		}
	}
	return fmt.Errorf("RustFS did not become ready; inspect %s", filepath.Join(dir, "rustfs.log"))
}
func (st *Storage) Status() map[string]any {
	st.mu.RLock()
	defer st.mu.RUnlock()
	return map[string]any{"ready": st.Ready, "error": st.Error, "version": "1.0.4"}
}
func (st *Storage) Close() {
	if st.cmd == nil || st.cmd.Process == nil {
		return
	}
	_ = st.cmd.Process.Signal(os.Interrupt)
	select {
	case <-st.wait:
	case <-time.After(8 * time.Second):
		_ = st.cmd.Process.Kill()
	}
}
func (st *Storage) Upload(ctx context.Context, name string, b []byte) (Attachment, error) {
	a, err := inspectImage(name, b)
	if err != nil {
		return Attachment{}, err
	}
	st.mu.RLock()
	ready, client := st.Ready, st.Client
	st.mu.RUnlock()
	if !ready || client == nil {
		return Attachment{}, &APIError{503, "Image storage is unavailable; check RustFS health"}
	}
	_, err = client.PutObject(ctx, "sift", a.ID, bytes.NewReader(b), int64(len(b)), minio.PutObjectOptions{ContentType: a.MIME})
	return a, err
}
func inspectImage(name string, b []byte) (Attachment, error) {
	if len(b) == 0 || len(b) > 20<<20 {
		return Attachment{}, invalid("Images must be at most 20 MB")
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(b))
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > 80_000_000 {
		return Attachment{}, invalid("Use a valid PNG/JPEG/WebP/GIF with at most 80 megapixels")
	}
	mime := map[string]string{"png": "image/png", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp"}[format]
	if mime == "" {
		return Attachment{}, invalid("Unsupported image format")
	}
	sum := sha256.Sum256(b)
	id := "img_" + hex.EncodeToString(sum[:16])
	return Attachment{ID: id, Name: filepath.Base(name), MIME: mime, Size: int64(len(b)), Width: cfg.Width, Height: cfg.Height, Hash: hex.EncodeToString(sum[:])}, nil
}
func (st *Storage) Read(ctx context.Context, id string) ([]byte, error) {
	st.mu.RLock()
	client := st.Client
	st.mu.RUnlock()
	if client == nil || !safeObjectID(id) {
		return nil, fmt.Errorf("RustFS unavailable")
	}
	obj, err := client.GetObject(ctx, "sift", id, minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	defer obj.Close()
	return io.ReadAll(io.LimitReader(obj, 21<<20))
}
func (st *Storage) ReadBase64(ctx context.Context, id string) (string, error) {
	b, e := st.Read(ctx, id)
	return base64.StdEncoding.EncodeToString(b), e
}
func safeObjectID(id string) bool {
	if !strings.HasPrefix(id, "img_") || len(id) != 36 {
		return false
	}
	_, e := hex.DecodeString(id[4:])
	return e == nil
}
