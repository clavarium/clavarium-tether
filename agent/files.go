package main

/* files.list / read / search / write / move / delete, inside the shared
 * folders only (paths.go). Sizes are capped as the keeper's own connectors cap
 * them.
 */

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
)

const (
	readMax  = 512 * 1024
	writeMax = 1_000_000
	listMax  = 500
	hitsMax  = 100
	walkMax  = 5000
)

type result struct {
	Text string
	Size int
	Exit *int
}

func textResult(s string) result { return result{Text: s, Size: len(s)} }

func refuse(format string, a ...any) error { return refusal(fmt.Sprintf(format, a...)) }

/* A refusal is told to the agent as is; any other error is a failure. */
type refusal string

func (r refusal) Error() string { return string(r) }

func pathErr(err error) error {
	var r refusal
	if errors.As(err, &r) {
		return err
	}
	if errors.Is(err, errOutside) || strings.Contains(err.Error(), "outside the shared") {
		return refusal(err.Error())
	}
	return err
}

func (f Folders) resolve(path string, follow bool) (string, string, error) {
	real, top, err := f.Resolve(path, follow)
	if err != nil {
		return "", "", pathErr(err)
	}
	return real, top, nil
}

func (f Folders) List(path string) (result, error) {
	real, _, err := f.resolve(path, true)
	if err != nil {
		if under := f.Under(path); len(under) > 0 && errors.Is(err, errOutside) {
			sort.Strings(under)
			lines := make([]string, len(under))
			for i, u := range under {
				lines[i] = u + "/"
			}
			return textResult(fmt.Sprintf("Shared folders: %d\n%s", len(under), strings.Join(lines, "\n"))), nil
		}
		if len(f.shares()) == 0 {
			return result{}, refuse("no folder is shared on this computer")
		}
		return result{}, err
	}
	entries, err := os.ReadDir(real)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return result{}, refuse("no such folder")
		}
		if errors.Is(err, syscall.ENOTDIR) {
			return result{}, refuse("that is a file, not a folder")
		}
		return result{}, err
	}
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].IsDir() != entries[j].IsDir() {
			return entries[i].IsDir()
		}
		return entries[i].Name() < entries[j].Name()
	})
	lines := []string{}
	for i, e := range entries {
		if i >= listMax {
			lines = append(lines, fmt.Sprintf("... and %d more", len(entries)-listMax))
			break
		}
		switch {
		case e.IsDir():
			lines = append(lines, e.Name()+"/")
		case e.Type()&fs.ModeSymlink != 0:
			lines = append(lines, e.Name()+" (link)")
		default:
			if info, err := e.Info(); err == nil {
				lines = append(lines, fmt.Sprintf("%s  %d", e.Name(), info.Size()))
			} else {
				lines = append(lines, e.Name())
			}
		}
	}
	word := "entries"
	if len(entries) == 1 {
		word = "entry"
	}
	text := fmt.Sprintf("%s: %d %s", f.ShowReal(real), len(entries), word)
	if len(lines) > 0 {
		text += "\n" + strings.Join(lines, "\n")
	}
	return textResult(text), nil
}

/* Opened without following a last link: the path was resolved just before. */
func openNoFollow(path string, flag int, perm os.FileMode) (*os.File, error) {
	return os.OpenFile(path, flag|syscall.O_NOFOLLOW, perm)
}

func (f Folders) Read(path string) (result, error) {
	real, _, err := f.resolve(path, true)
	if err != nil {
		return result{}, err
	}
	st, err := os.Stat(real)
	if err != nil {
		return result{}, refuse("no such file")
	}
	if st.IsDir() {
		return result{}, refuse("that is a folder: list it")
	}
	if st.Size() > readMax {
		return result{}, refuse("%d bytes: too big to read here (%d at most)", st.Size(), readMax)
	}
	fh, err := openNoFollow(real, os.O_RDONLY, 0)
	if err != nil {
		return result{}, err
	}
	defer fh.Close()
	buf, err := io.ReadAll(io.LimitReader(fh, readMax+1))
	if err != nil {
		return result{}, err
	}
	if bytes.IndexByte(buf, 0) >= 0 {
		return result{Text: fmt.Sprintf("a binary file of %d bytes: not shown", len(buf)), Size: len(buf)}, nil
	}
	return result{Text: string(buf), Size: len(buf)}, nil
}

func (f Folders) Search(text, path string) (result, error) {
	q := strings.ToLower(strings.TrimSpace(text))
	if q == "" {
		return result{}, refuse("say what to look for")
	}
	tops := []string{}
	if real, _, err := f.resolve(path, true); err == nil {
		tops = append(tops, real)
	} else if errors.Is(err, errOutside) || strings.Contains(err.Error(), "outside the shared") {
		for _, s := range f.shares() {
			if abs, e := f.abs(path); e == nil && inside(s.given, abs) {
				tops = append(tops, s.real)
			}
		}
		if len(tops) == 0 {
			return result{}, err
		}
	} else {
		return result{}, err
	}
	hits := []string{}
	seen := 0
	stop := errors.New("enough")
	for _, top := range tops {
		_ = filepath.WalkDir(top, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if len(hits) >= hitsMax || seen >= walkMax {
				return stop
			}
			seen++
			if p == top {
				return nil
			}
			rel, _ := filepath.Rel(top, p)
			if strings.Count(rel, string(filepath.Separator)) > 8 {
				return fs.SkipDir
			}
			if d.IsDir() && (d.Name() == ".git" || d.Name() == "node_modules") {
				return fs.SkipDir
			}
			shown := f.ShowReal(p)
			if strings.Contains(strings.ToLower(d.Name()), q) {
				if d.IsDir() {
					hits = append(hits, shown+"/")
				} else {
					hits = append(hits, shown)
				}
			}
			if !d.Type().IsRegular() {
				return nil
			}
			info, err := d.Info()
			if err != nil || info.Size() > readMax {
				return nil
			}
			buf, err := os.ReadFile(p)
			if err != nil || bytes.IndexByte(buf, 0) >= 0 {
				return nil
			}
			for i, line := range strings.Split(string(buf), "\n") {
				if len(hits) >= hitsMax {
					break
				}
				if strings.Contains(strings.ToLower(line), q) {
					l := strings.TrimSpace(line)
					if len(l) > 200 {
						l = l[:200]
					}
					hits = append(hits, fmt.Sprintf("%s:%d: %s", shown, i+1, l))
				}
			}
			return nil
		})
	}
	if len(hits) == 0 {
		return textResult("Nothing found."), nil
	}
	return textResult(strings.Join(hits, "\n")), nil
}

func (f Folders) Write(path, text string) (result, error) {
	if len(text) > writeMax {
		return result{}, refuse("too long to write (%d bytes at most)", writeMax)
	}
	real, _, err := f.resolve(path, true)
	if err != nil {
		return result{}, err
	}
	if st, err := os.Stat(real); err == nil && st.IsDir() {
		return result{}, refuse("that is a folder")
	}
	if err := os.MkdirAll(filepath.Dir(real), 0o755); err != nil {
		return result{}, err
	}
	/* Resolved again once its folder exists: nothing made it lead outside meanwhile. */
	if again, _, err := f.resolve(path, true); err != nil || again != real {
		return result{}, refuse("that path changed while it was written")
	}
	fh, err := openNoFollow(real, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return result{}, err
	}
	if _, err := fh.WriteString(text); err != nil {
		fh.Close()
		return result{}, err
	}
	if err := fh.Close(); err != nil {
		return result{}, err
	}
	return result{Text: fmt.Sprintf("Written: %s (%d bytes).", f.ShowReal(real), len(text)), Size: len(text)}, nil
}

func (f Folders) Move(from, to string) (result, error) {
	a, topA, err := f.resolve(from, false)
	if err != nil {
		return result{}, err
	}
	b, _, err := f.resolve(to, false)
	if err != nil {
		return result{}, err
	}
	if a == topA {
		return result{}, refuse("a shared folder itself is not moved")
	}
	if _, err := os.Lstat(a); err != nil {
		return result{}, refuse("nothing there to move")
	}
	if _, err := os.Lstat(b); err == nil {
		return result{}, refuse("something is there already")
	}
	if err := os.MkdirAll(filepath.Dir(b), 0o755); err != nil {
		return result{}, err
	}
	if err := os.Rename(a, b); err != nil {
		return result{}, err
	}
	return result{Text: fmt.Sprintf("Moved: %s → %s.", f.ShowReal(a), f.ShowReal(b))}, nil
}

func (f Folders) Delete(path string) (result, error) {
	real, top, err := f.resolve(path, false)
	if err != nil {
		return result{}, err
	}
	if real == top {
		return result{}, refuse("a shared folder itself is not deleted")
	}
	st, err := os.Lstat(real)
	if err != nil {
		return result{}, refuse("nothing there")
	}
	if st.IsDir() {
		if err := syscall.Rmdir(real); err != nil {
			if errors.Is(err, syscall.ENOTEMPTY) || errors.Is(err, syscall.EEXIST) {
				return result{}, refuse("that folder is not empty")
			}
			return result{}, err
		}
	} else if err := os.Remove(real); err != nil {
		return result{}, err
	}
	return result{Text: fmt.Sprintf("Deleted: %s.", f.ShowReal(real))}, nil
}
