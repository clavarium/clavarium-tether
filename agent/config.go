package main

/* WHAT THIS COMPUTER KEEPS: which keeper it is paired with, and the folders
 * the person shared. In ~/.config/tether-agent/ (or $XDG_CONFIG_HOME):
 *
 *   config.json   { keeper, device, shares }       0600
 *   token         the long-lived key of this device 0600, never printed
 *
 * The folder list is read again for every call: a folder shared or unshared
 * while `run` is going counts at once.
 */

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const appName = "tether-agent"

type Config struct {
	Keeper string   `json:"keeper,omitempty"`
	Device string   `json:"device,omitempty"`
	Title  string   `json:"title,omitempty"`
	Shares []string `json:"shares"`
}

func configDir() (string, error) {
	if x := os.Getenv("XDG_CONFIG_HOME"); x != "" && filepath.IsAbs(x) {
		return filepath.Join(x, appName), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", appName), nil
}

func ensureDir() (string, error) {
	dir, err := configDir()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	_ = os.Chmod(dir, 0o700)
	return dir, nil
}

func loadConfig() (Config, error) {
	var c Config
	dir, err := configDir()
	if err != nil {
		return c, err
	}
	b, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if errors.Is(err, os.ErrNotExist) {
		return c, nil
	}
	if err != nil {
		return c, err
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return c, fmt.Errorf("config.json is not readable: %w", err)
	}
	return c, nil
}

/* Written whole, through a file beside it renamed over the old one. */
func writePrivate(name string, data []byte) error {
	dir, err := ensureDir()
	if err != nil {
		return err
	}
	tmp := filepath.Join(dir, "."+name+".tmp")
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	_ = os.Chmod(tmp, 0o600)
	return os.Rename(tmp, filepath.Join(dir, name))
}

func saveConfig(c Config) error {
	if c.Shares == nil {
		c.Shares = []string{}
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	return writePrivate("config.json", append(b, '\n'))
}

func saveToken(token string) error { return writePrivate("token", []byte(token+"\n")) }

func loadToken() (string, error) {
	dir, err := configDir()
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, "token")
	st, err := os.Lstat(path)
	if err != nil {
		return "", errors.New("this computer is not paired: run " + appName + " pair URL")
	}
	if !st.Mode().IsRegular() {
		return "", errors.New("the token is not a plain file")
	}
	if st.Mode().Perm()&0o077 != 0 {
		_ = os.Chmod(path, 0o600)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	t := strings.TrimSpace(string(b))
	if t == "" {
		return "", errors.New("the token is empty: pair again")
	}
	return t, nil
}

func forget() error {
	dir, err := configDir()
	if err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(dir, "token")); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	c, err := loadConfig()
	if err != nil {
		return err
	}
	c.Keeper, c.Device, c.Title = "", "", ""
	return saveConfig(c)
}
