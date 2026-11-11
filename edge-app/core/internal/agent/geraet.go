package agent

import (
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraet"
)

// SetGeraet legt fest, was das Programm beim Start ueber sein Geraet erkannt
// hat (Geraete & Updates G8). Der Programmrahmen ruft es einmal vor Start auf;
// ohne Aufruf (Tests) traegt der Update-Block keine Geraete-Angabe.
func (a *Agent) SetGeraet(g geraet.Erkannt) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.geraet = &g
}

// geraetSummary ist update.geraet: Modell und Architektur aus der Erkennung,
// bei Edge Light dazu der Loader-Stand - ob er das Update-Protokoll kennt
// (otaLightLoaderBereit, Stufe 2) oder nur die Fassung aus dem Flash startet
// (Stufe 1). So muss die Cloud die Stufe nicht mehr aus dem Vertrauens-Set raten.
func (a *Agent) geraetSummary() *cloud.GeraetSummary {
	a.mu.Lock()
	g := a.geraet
	a.mu.Unlock()
	if g == nil {
		return nil
	}
	sum := &cloud.GeraetSummary{Modell: g.Modell, Arch: g.Arch}
	if a.isLight() {
		sum.Loader = cloud.LoaderFlash
		if a.otaLightLoaderBereit() {
			sum.Loader = cloud.LoaderUpdate
		}
		// Die LOADER_STAND-Marke des Loaders im Flash (loader_pflege.go);
		// 0 (alter Loader ohne Marke, noch nicht gelesen) bleibt weg.
		sum.LoaderStand = a.loaderStand()
	}
	return sum
}
