package konfig

import "git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/wartung"

func wartungSchluessel(dir string) (string, string, error) {
	return wartung.NeueSchluessel(dir, DateiTechnikerWG, DateiTechnikerSSH)
}
