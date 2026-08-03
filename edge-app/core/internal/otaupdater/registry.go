package otaupdater

// Die Registry-Zugangsdaten DIESES Geraets.
//
// # Die Entscheidung, und warum sie so faellt
//
// Der autonome Pull braucht stehende Zugangsdaten (Vorentwurf §6, Befund A1) -
// bis Stufe 2 hat sie ein Mensch mitgebracht. Forgejos Token-Modell ist
// BENUTZER-bezogen, nicht Repository-bezogen: es gibt keine
// „Repo-Deploy-Token" fuer die Paket-Registry. Ein Token JE GERAET erzwaenge
// also entweder einen Benutzer je Geraet oder mehrere Token an EINEM Benutzer.
//
// Gewaehlt: **ein reiner Lese-Bot-Benutzer (`read:package`), und daran EIN
// BENANNTES TOKEN JE GERAET.** Forgejo erlaubt beliebig viele benannte Token je
// Benutzer und das Zuruecknehmen eines einzelnen - „Geraet X den Zugang
// entziehen" ist damit ein Klick, ohne die uebrige Flotte zu beruehren. Das
// Geraet legt seinen Zugang unter `/data` ab, neben `device.key`, nie in einem
// Image: ein Image ist fuer die ganze Flotte gleich, ein Zugang gehoert genau
// einer Box.
//
// **Die Grenze wird benannt, nicht versteckt:** alle diese Token tragen
// denselben Umfang, ein gestohlenes Geraet kann also jedes Edge-Image ziehen.
// Bei dieser Flottengroesse ist das vertretbar - es ist Lesezugriff auf
// Software, die ohnehin auf jeder Box liegt. Der Rueckfall, falls dem
// Betreiber die Token-Pflege zu viel wird, ist EIN flottenweites
// Nur-Lese-Token mit dokumentierter Rotation; am Code aendert das nichts, weil
// er ohnehin je Geraet eine Datei liest.

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// FileRegistryAuth ist der Ablageort unter <data>/ota/.
const FileRegistryAuth = "registry-auth.json"

// RegistryAuth ist der Nur-Lese-Zugang dieses Geraets.
type RegistryAuth struct {
	Registry string `json:"registry"`
	Username string `json:"username"`
	Token    string `json:"token"`
}

// ReadRegistryAuth liest den Zugang. (nil, nil) = keiner hinterlegt, was ein
// gueltiger Zustand ist (eine Box, deren Daemon schon eingeloggt ist).
func ReadRegistryAuth(dataDir string) (*RegistryAuth, error) {
	path := filepath.Join(dataDir, "ota", FileRegistryAuth)
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var a RegistryAuth
	if err := json.Unmarshal(raw, &a); err != nil {
		return nil, err
	}
	a.Registry = strings.TrimSpace(a.Registry)
	a.Username = strings.TrimSpace(a.Username)
	a.Token = strings.TrimSpace(a.Token)
	if a.Registry == "" || a.Username == "" || a.Token == "" {
		return nil, errIncomplete
	}
	return &a, nil
}

type authError string

func (e authError) Error() string { return string(e) }

const errIncomplete authError = "registry-auth.json ist unvollstaendig " +
	"(registry, username und token sind alle drei Pflicht)"

// WriteDockerConfig erzeugt die `config.json`, die der docker-Client liest.
//
// Bewusst ohne `docker login`: der Login-Aufruf schriebe dieselbe Datei, nur
// mit einem zusaetzlichen Netz-Aufruf, der genau dann scheitert, wenn die
// Registry gerade weg ist - und dann steht der Sidecar ohne Zugangsdaten da,
// obwohl er sie hat. Ein schlechtes Token faellt beim Pull mit einer klaren
// Meldung auf; das ist frueh genug, denn vor dem Pull wird nichts gestoppt.
func WriteDockerConfig(dir string, a *RegistryAuth) error {
	if a == nil {
		return nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	cfg := map[string]any{
		"auths": map[string]any{
			a.Registry: map[string]any{
				"auth": base64.StdEncoding.EncodeToString([]byte(a.Username + ":" + a.Token)),
			},
		},
	}
	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	path := filepath.Join(dir, "config.json")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
