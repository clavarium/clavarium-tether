package main

/* THE FOLDERS: files are read and written only inside the folders the person
 * shared, and this program checks it itself, whatever the keeper sent.
 *
 * A path from the keeper reads as the person's: "~/Projects/a.txt" is under
 * their home, "notes.txt" too, "/srv/data/x" is as written. ".." is resolved
 * first. Then:
 *
 *   - the path must be at or under a shared folder (as written, or as the
 *     folder really is once its links are followed);
 *   - the nearest part of it that exists is resolved, links included, and
 *     must still be under that folder's real place. A link inside a shared
 *     folder pointing outside is outside.
 *
 * `follow` resolves the last part too (read, list, write: the file a link
 * names). Without it (move, delete) the link itself is what is acted on, so
 * its parent is resolved and the name kept.
 */

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

var errOutside = errors.New("that path is outside the shared folders")

type Folders struct {
	Home   string
	Shares []string
}

func inside(p, top string) bool {
	if top == "/" {
		return strings.HasPrefix(p, "/")
	}
	return p == top || strings.HasPrefix(p, top+string(filepath.Separator))
}

/* The path as an absolute, clean path on this computer. */
func (f Folders) abs(given string) (string, error) {
	g := strings.TrimSpace(given)
	if g == "" || g == "." {
		g = "~"
	}
	if strings.ContainsRune(g, 0) {
		return "", errors.New("that path holds a zero byte")
	}
	switch {
	case g == "~":
		g = f.Home
	case strings.HasPrefix(g, "~/"):
		g = filepath.Join(f.Home, g[2:])
	case !filepath.IsAbs(g):
		g = filepath.Join(f.Home, g)
	}
	return filepath.Clean(g), nil
}

/* What a path really is, links followed, for the part of it that exists. */
func realOf(p string) (string, error) {
	rest := ""
	probe := p
	for {
		r, err := filepath.EvalSymlinks(probe)
		if err == nil {
			if rest == "" {
				return r, nil
			}
			return filepath.Join(r, rest), nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		up := filepath.Dir(probe)
		if up == probe {
			return p, nil
		}
		base := filepath.Base(probe)
		if rest == "" {
			rest = base
		} else {
			rest = filepath.Join(base, rest)
		}
		probe = up
	}
}

/* A shared folder: as configured, and its real place (empty when it is gone). */
type share struct{ given, real string }

func (f Folders) shares() []share {
	out := []share{}
	for _, s := range f.Shares {
		c := filepath.Clean(s)
		if !filepath.IsAbs(c) {
			continue
		}
		r, err := filepath.EvalSymlinks(c)
		if err != nil {
			continue
		}
		if st, err := os.Stat(r); err != nil || !st.IsDir() {
			continue
		}
		out = append(out, share{c, r})
	}
	return out
}

/* Resolve: the real path to act on, and the shared folder (real) it is in. */
func (f Folders) Resolve(given string, follow bool) (string, string, error) {
	p, err := f.abs(given)
	if err != nil {
		return "", "", err
	}
	for _, s := range f.shares() {
		var rel string
		switch {
		case inside(p, s.given):
			rel, _ = filepath.Rel(s.given, p)
		case inside(p, s.real):
			rel, _ = filepath.Rel(s.real, p)
		default:
			continue
		}
		lexical := filepath.Join(s.real, rel)
		var real string
		if follow || lexical == s.real {
			real, err = realOf(lexical)
		} else {
			var parent string
			parent, err = realOf(filepath.Dir(lexical))
			real = filepath.Join(parent, filepath.Base(lexical))
		}
		if err != nil {
			return "", "", err
		}
		if !inside(real, s.real) {
			return "", "", errors.New("that path leads outside the shared folders")
		}
		return real, s.real, nil
	}
	return "", "", errOutside
}

/* The shared folders under a path that is not itself shared ("~": all of them under home). */
func (f Folders) Under(given string) []string {
	p, err := f.abs(given)
	if err != nil {
		return nil
	}
	out := []string{}
	for _, s := range f.shares() {
		if inside(s.given, p) && s.given != p {
			out = append(out, f.Show(s.given))
		}
	}
	return out
}

/* A path as the keeper and the person read it: "~/..." under home. */
func (f Folders) Show(p string) string {
	if f.Home != "" && f.Home != "/" {
		if p == f.Home {
			return "~"
		}
		if strings.HasPrefix(p, f.Home+"/") {
			return "~/" + p[len(f.Home)+1:]
		}
	}
	return p
}

/* A real path shown by the shared folder it is in, the way it was shared. */
func (f Folders) ShowReal(real string) string {
	for _, s := range f.shares() {
		if inside(real, s.real) {
			rel, _ := filepath.Rel(s.real, real)
			return f.Show(filepath.Join(s.given, rel))
		}
	}
	return f.Show(real)
}
