package componentapply

// UPDATE-KONTINUITÄT: eine Bindung, die vor dem Update galt, gilt danach.
//
// Der reproduzierte Live-Defekt (Anlage Pilsting/Herzogau, Update
// edge-2026.08.5 -> .10): die Box lief mit zwei Fronius-Quellen, deren
// Kennungen aus der Zeit VOR sources.DeterministicID stammen und deshalb
// zufällig sind (die deterministischen Kennungen wurden bewusst OHNE Migration
// eingeführt - eine Migration hätte genau die Pins gerissen, die sie schützen
// sollten). Die Bestands-Übernahme leitete daraus deterministische Kennungen ab,
// schrieb sources.json neu, und dieselben Wechselrichter erschienen im Portal
// als "Neues Gerät gefunden", während ihre Komponenten "nicht mehr mit einem
// gemeldeten Gerät verbunden" lasen. Messwerte flossen weiter - nur die
// Zuordnung riss.
//
// Die Tests hier fahren beide Seiten des Fensters an derselben Konfiguration:
// die 08.5-Identität (was die Box WIRKLICH fuhr) gegen die Ableitung des neuen
// Schemas.

import (
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

// Die zweite Fronius-Einheit hinter DERSELBEN IP - die Pilsting-Form: zwei
// Fronius Eco an einem Datamanager, unterschieden allein durch die Unit-Id.
const froniusDriverUnit2 = `{"role":"pv-generation","brand":"fronius_sunspec",
  "model":"fronius-eco-27-3-s","communication":"fronius_sunspec","capacity_kwp":27,
  "interval_s":5,"connection":{"ip":"192.168.210.40","port":502,"unit_id":2}}`

// pilstingPush ist der Soll-Stand, den die Cloud nach der Übernahme zurückgibt.
func pilstingPush() entities.Registry {
	return portal(
		ent("5f0d2c9e-0000-0000-0000-000000000001", entities.TypeBatteryHybrid, deyeDriver),
		ent("6a1e3d0f-0000-0000-0000-000000000002", entities.TypeProducer, froniusDriver),
		ent("6a1e3d0f-0000-0000-0000-000000000003", entities.TypeProducer, froniusDriverUnit2),
	)
}

// legacyRunning baut die 08.5-Identität: exakt die Geräte des Pushes, aber mit
// den ZUFÄLLIGEN Kennungen, die eine vor den deterministischen Kennungen
// eingerichtete Box bis heute trägt.
func legacyRunning(t *testing.T) []sources.Source {
	t.Helper()
	derived, err := Derive(pilstingPush(), cat(), nil, now)
	if err != nil {
		t.Fatalf("Aufbau: %v", err)
	}
	out := make([]sources.Source, 0, len(derived.Sources))
	for i, s := range derived.Sources {
		s.ID = []string{"src-a7k3mq2p", "src-zt9wb4hd"}[i] // zufällig vergeben, wie vor PR 270
		out = append(out, s)
	}
	return out
}

func TestATakeoverKeepsTheIdentityOfEveryDeviceTheBoxAlreadyRuns(t *testing.T) {
	running := legacyRunning(t)

	// Der Beweis, dass der Aufbau den Defekt wirklich trifft: OHNE das laufende
	// Ist würde jede Kennung neu vergeben.
	blind, err := Derive(pilstingPush(), cat(), nil, now)
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}
	for i := range blind.Sources {
		if blind.Sources[i].ID == running[i].ID {
			t.Fatal("Aufbau untauglich: die abgeleitete Kennung ist zufällig gleich " +
				"der laufenden - dann prüft der Test nichts")
		}
	}

	plan, err := Derive(pilstingPush(), cat(), running, now)
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}
	if len(plan.Sources) != 2 {
		t.Fatalf("Quellen = %d, will 2", len(plan.Sources))
	}
	for i := range plan.Sources {
		if plan.Sources[i].ID != running[i].ID {
			t.Fatalf("Quelle %d: Kennung %q, will die laufende %q - die Portal-Bindung "+
				"reisst", i, plan.Sources[i].ID, running[i].ID)
		}
	}
	// Und damit ist die Übernahme das, was sie sein soll: nichts wird
	// geschrieben, nichts neu veröffentlicht.
	inv := *plan.Inverter
	if !plan.SameAs(&inv, running) {
		t.Fatal("die Übernahme ist kein No-op - sources.json würde neu geschrieben")
	}
}

func TestTheTwoUnitsBehindOneAddressKeepTheirOwnIdentities(t *testing.T) {
	running := legacyRunning(t)
	plan, err := Derive(pilstingPush(), cat(), running, now)
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}
	byUnit := map[int]sources.Source{}
	for _, s := range plan.Sources {
		byUnit[s.Connection.UnitID] = s
	}
	if len(byUnit) != 2 {
		t.Fatalf("die zwei Einheiten hinter einer IP wurden zusammengefaltet: %+v", plan.Sources)
	}
	if byUnit[1].ID == byUnit[2].ID {
		t.Fatal("beide Einheiten teilen sich eine Kennung")
	}
	// Jede Einheit behält GENAU ihre eigene - nicht die des Nachbarn.
	for _, want := range running {
		got, ok := byUnit[want.Connection.UnitID]
		if !ok || got.ID != want.ID {
			t.Fatalf("Einheit %d: Kennung %q, will %q", want.Connection.UnitID, got.ID, want.ID)
		}
	}
}

func TestADeviceTheBoxDoesNotRunStillGetsItsDeterministicIdentity(t *testing.T) {
	running := legacyRunning(t)[:1] // nur die erste Fronius läuft hier

	plan, err := Derive(pilstingPush(), cat(), running, now)
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}
	var kept, minted int
	for _, s := range plan.Sources {
		if s.ID == running[0].ID {
			kept++
			continue
		}
		if s.ID != sources.DeterministicID(s) {
			t.Fatalf("ein neues Gerät bekam weder die laufende noch die deterministische "+
				"Kennung: %q", s.ID)
		}
		minted++
	}
	if kept != 1 || minted != 1 {
		t.Fatalf("behalten=%d neu=%d, will 1/1", kept, minted)
	}
}

func TestAnAlreadyDeterministicPlantIsUnaffectedByTheRule(t *testing.T) {
	// Eine nach PR 270 eingerichtete Anlage trägt schon die deterministischen
	// Kennungen - die Regel muss dort ein exaktes No-op sein.
	base, err := Derive(pilstingPush(), cat(), nil, now)
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}
	again, err := Derive(pilstingPush(), cat(), base.Sources, now)
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}
	for i := range again.Sources {
		if again.Sources[i].ID != base.Sources[i].ID {
			t.Fatalf("Quelle %d: %q != %q", i, again.Sources[i].ID, base.Sources[i].ID)
		}
	}
}

func TestARoleChangeNeverRevivesAForeignIdentity(t *testing.T) {
	// Die Rolle ist Teil der Transport-Identität (die dokumentierte Regel von
	// DeterministicID): dasselbe Gerät unter einer ANDEREN Rolle ist ein anderes
	// Messgerät, und sein Pin darf nicht wiederbelebt werden.
	running := legacyRunning(t)
	running[0].Role = sources.RoleNetz

	plan, err := Derive(pilstingPush(), cat(), running, now)
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}
	for _, s := range plan.Sources {
		if s.ID == running[0].ID {
			t.Fatalf("die Kennung eines Netz-Zählers wurde für einen Erzeuger "+
				"wiederverwendet: %q", s.ID)
		}
	}
}

func TestAnAmbiguousLocalIdentityIsNeverAssignedByCoinToss(t *testing.T) {
	// Zwei laufende Quellen mit identischer Transport-Identität kann es nur über
	// den lauten Kollisions-Fallback von AddSource geben. Eine davon zu wählen
	// wäre ein Münzwurf darüber, welcher Pin überlebt - also gewinnt die, die
	// ohnehin schon die deterministische Kennung trägt.
	running := legacyRunning(t)
	twin := running[0]
	twin.ID = sources.DeterministicID(twin)
	running = append(running, twin)

	plan, err := Derive(pilstingPush(), cat(), running, now)
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}
	if plan.Sources[0].ID != twin.ID {
		t.Fatalf("Kennung %q, will die deterministische %q", plan.Sources[0].ID, twin.ID)
	}

	// Ohne einen solchen Anker wird gar nichts übernommen.
	running[1].ID = "src-cccccccc"
	plan, err = Derive(pilstingPush(), cat(), running, now)
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}
	got := plan.Sources[0]
	if got.ID != sources.DeterministicID(got) {
		t.Fatalf("bei Mehrdeutigkeit muss die deterministische Kennung gelten, war %q", got.ID)
	}
}

func TestTwoEntitiesWithTheSameConnectionAreStillRefusedByName(t *testing.T) {
	// Der Kollisions-Schutz keyt seit dieser Regel auf die Transport-Identität
	// statt auf die abgeleitete Kennung - er muss trotzdem greifen, auch wenn
	// eine der beiden eine laufende Kennung erben würde.
	running := legacyRunning(t)
	reg := portal(
		ent("6a1e3d0f-0000-0000-0000-000000000002", entities.TypeProducer, froniusDriver),
		ent("6a1e3d0f-0000-0000-0000-000000000009", entities.TypeProducer, froniusDriver),
	)
	_, err := Derive(reg, cat(), running, now)
	if err == nil {
		t.Fatal("zwei Geräte mit derselben Verbindung müssen abgelehnt werden")
	}
}
