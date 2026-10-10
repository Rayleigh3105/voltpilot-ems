package measurements

import (
	"encoding/json"
	"testing"
	"time"
)

// Der Verlust hat ein FENSTER, und die Box soll es melden koennen (AP-07 IP-19).
// Gemeldet wird eine Episode, nicht jeder einzelne verworfene Umschlag: solange der
// Uplink weg ist, verdraengt jeder Takt erneut.
func TestVerdraengungMeldetDasFensterEinerEpisodeGenauEinmal(t *testing.T) {
	dir := t.TempDir()
	id := Identity{TenantID: "t", SiteID: "s", DeviceID: "d"}
	o, err := OpenOutbox(dir, 2)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Date(2026, 11, 3, 9, 40, 0, 0, time.UTC)
	for i := 0; i < 4; i++ {
		if _, err := o.Append(batch(start.Add(time.Duration(i)*time.Minute)), id); err != nil {
			t.Fatal(err)
		}
	}
	// Die Episode laeuft noch - nichts wird herausgegeben.
	if _, _, _, ok := o.Verdraengung(); ok {
		t.Fatal("Fenster waehrend der laufenden Verdraengung gemeldet")
	}
	// Die Rueckkehr: die Outbox laeuft leer, der naechste Takt verdraengt nichts.
	for {
		e, weiter := o.Next()
		if !weiter {
			break
		}
		if err := o.Ack(e.Sequence); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := o.Append(batch(start.Add(9*time.Minute)), id); err != nil {
		t.Fatal(err)
	}
	von, bis, samples, ok := o.Verdraengung()
	if !ok {
		t.Fatal("kein Fenster")
	}
	// [von, bis): der aelteste verworfene Umschlag bis zum aeltesten ueberlebenden.
	if !von.Equal(start) || !bis.Equal(start.Add(2*time.Minute)) || samples != 2 {
		t.Fatalf("Fenster: %s bis %s, %d Werte", von, bis, samples)
	}
	// Genau einmal.
	if _, _, _, nochmal := o.Verdraengung(); nochmal {
		t.Fatal("dasselbe Fenster zweimal gemeldet")
	}
	// Und es ueberlebt einen Neustart, solange es nicht abgeholt wurde.
	o2, err := OpenOutbox(dir, 2)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, ok := o2.Verdraengung(); ok {
		t.Fatal("abgeholtes Fenster nach dem Neustart wieder da")
	}
}

// Mischbetrieb, Richtung "neue Box an heutiger Cloud": der Mess-Umschlag bleibt
// byte-gleich. Das Fenster der Verdraengung lebt NUR im state.json, nie am Draht.
func TestDerMessUmschlagBekommtKeinNeuesFeld(t *testing.T) {
	id := Identity{TenantID: "t", SiteID: "s", DeviceID: "d"}
	o, err := OpenOutbox(t.TempDir(), 2)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Date(2026, 11, 3, 9, 40, 0, 0, time.UTC)
	for i := 0; i < 3; i++ {
		if _, err := o.Append(batch(start.Add(time.Duration(i)*time.Minute)), id); err != nil {
			t.Fatal(err)
		}
	}
	e, ok := o.Next()
	if !ok {
		t.Fatal("nichts zu senden")
	}
	var wire map[string]any
	if err := json.Unmarshal(e.Raw, &wire); err != nil {
		t.Fatal(err)
	}
	erlaubt := map[string]bool{"schema_version": true, "tenant_id": true, "site_id": true,
		"device_id": true, "catalog_version": true, "sequence": true, "observed_at": true,
		"samples": true, "dropped_samples": true, "gap": true, "applied_revision": true}
	for feld := range wire {
		if !erlaubt[feld] {
			t.Fatalf("neues Feld im Mess-Umschlag: %q", feld)
		}
	}
	if wire["schema_version"] != "2.0" || wire["gap"] != true {
		t.Fatalf("Umschlag: %v", wire)
	}
}
