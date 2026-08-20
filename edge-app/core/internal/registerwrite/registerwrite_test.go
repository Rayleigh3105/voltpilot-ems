package registerwrite

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	tenant = "00000000-0000-0000-0000-000000000001"
	site   = "00000000-0000-0000-0000-000000000002"
	device = "00000000-0000-0000-0000-000000000003"
)

func ident() Identity {
	return Identity{TenantID: tenant, SiteID: site, DeviceID: device}
}

func order(mode string, extra map[string]any) []byte {
	m := map[string]any{
		"schema_version": SchemaVersion, "type": TypeRequest,
		"tenant_id": tenant, "site_id": site, "device_id": device,
		"request_id": "9f2c41ab77d05e14", "requested_at": time.Now().UTC().Format(time.RFC3339),
		"mode":     mode,
		"target":   map[string]any{"kind": LanePrimary},
		"register": map[string]any{"kind": KindHolding, "address": 231},
	}
	if mode == ModeWrite {
		m["value"] = 7000
		m["confirm"] = "0X00E7=7000"
	}
	for k, v := range extra {
		if v == nil {
			delete(m, k)
			continue
		}
		m[k] = v
	}
	raw, _ := json.Marshal(m)
	return raw
}

func TestAWellFormedOrderParses(t *testing.T) {
	req, err := Parse(order(ModeWrite, nil))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !req.Apply() {
		t.Fatal("ein schreibender Auftrag muss als solcher erkannt werden")
	}
	if req.Value == nil || *req.Value != 7000 || req.Register.Address != 231 {
		t.Fatalf("Werte nicht wie erwartet: %+v", req)
	}
	if !req.Matches(ident()) {
		t.Fatal("die eigene Identitaet muss passen")
	}
	if v := req.Admissible(); !v.OK() {
		t.Fatalf("die primaere Lane wird ausgefuehrt: %+v", v)
	}
}

// Der Vertrag verbietet einen Schreib-Auftrag ohne Wert oder Bestaetigung; ein
// halb geformter Auftrag darf nicht weiter als bis zum Parser reisen.
func TestAWriteWithoutValueOrConfirmNeverLeavesTheParser(t *testing.T) {
	if _, err := Parse(order(ModeWrite, map[string]any{"value": nil})); err == nil {
		t.Fatal("ein Schreib-Auftrag ohne Wert muss abgelehnt werden")
	}
	if _, err := Parse(order(ModeWrite, map[string]any{"confirm": nil})); err == nil {
		t.Fatal("ein Schreib-Auftrag ohne Bestaetigung muss abgelehnt werden")
	}
	// Eine Vorschau braucht beides NICHT.
	if _, err := Parse(order(ModeRead, nil)); err != nil {
		t.Fatalf("die Vorschau ist vollstaendig: %v", err)
	}
}

func TestMalformedOrdersAreRefusedByForm(t *testing.T) {
	cases := map[string]map[string]any{
		"fremde Version":       {"schema_version": "2.0"},
		"fremder Typ":          {"type": "probe_request"},
		"keine Hex-Kennung":    {"request_id": "NICHT-HEX"},
		"zu kurze Kennung":     {"request_id": "abc"},
		"unbekannter Modus":    {"mode": "loeschen"},
		"Adresse jenseits 16b": {"register": map[string]any{"kind": KindHolding, "address": 70000}},
		"unbekannte Art":       {"register": map[string]any{"kind": "spulchen", "address": 1}},
	}
	for name, extra := range cases {
		if _, err := Parse(order(ModeRead, extra)); err == nil {
			t.Fatalf("%s haette abgelehnt werden muessen", name)
		}
	}
	if _, err := Parse(nil); err == nil {
		t.Fatal("eine leere Anfrage ist keine Anfrage")
	}
}

// Eine fremde Identitaet wird verworfen - eine Antwort bestaetigte einem falsch
// adressierten Absender die Existenz dieses Geraets.
func TestAForeignIdentityNeverMatches(t *testing.T) {
	req, _ := Parse(order(ModeRead, map[string]any{
		"device_id": "00000000-0000-0000-0000-0000000000ff"}))
	if req.Matches(ident()) {
		t.Fatal("ein fremdes Geraet darf nie passen")
	}
	// Ohne eigene Identitaet passt gar nichts (eine Box vor der Beanspruchung).
	ok, _ := Parse(order(ModeRead, nil))
	if ok.Matches(Identity{}) {
		t.Fatal("ohne eigene Identitaet darf nichts passen")
	}
	// Gross-/Kleinschreibung der UUID ist kein Unterschied.
	upper, _ := Parse(order(ModeRead, map[string]any{"device_id": "00000000-0000-0000-0000-000000000003"}))
	if !upper.Matches(ident()) {
		t.Fatal("dieselbe Kennung muss passen")
	}
}

// requested_at ist der Fensterbeginn, nicht die Empfangszeit - sonst waere eine
// nachgelieferte QoS1-Nachricht bei ihrer Ankunft wieder taufrisch und wuerde
// einen weiteren EEPROM-Schreibzyklus kosten.
func TestExpiryCountsFromTheEnvelopesOwnStamp(t *testing.T) {
	now := time.Date(2026, 8, 19, 14, 0, 0, 0, time.UTC)
	fresh, _ := Parse(order(ModeWrite, map[string]any{
		"requested_at": now.Add(-30 * time.Second).Format(time.RFC3339)}))
	if fresh.Expired(now, DefaultWindow) {
		t.Fatal("ein 30 s alter Auftrag ist frisch")
	}
	old, _ := Parse(order(ModeWrite, map[string]any{
		"requested_at": now.Add(-3 * time.Minute).Format(time.RFC3339)}))
	if !old.Expired(now, DefaultWindow) {
		t.Fatal("ein 3 min alter Auftrag ist verfallen")
	}
	// Ein unlesbarer Stempel gilt als verfallen - im Zweifel wird nicht
	// geschrieben.
	bad, _ := Parse(order(ModeWrite, map[string]any{"requested_at": "irgendwann"}))
	if !bad.Expired(now, DefaultWindow) {
		t.Fatal("ein unlesbarer Stempel muss als verfallen gelten")
	}
	// Ein Stempel in der ZUKUNFT ist nicht verfallen: die zwei Uhren sind
	// unabhaengig, und eine nachlaufende Box darf keine Arbeit ablehnen, auf die
	// das Portal gerade wartet.
	future, _ := Parse(order(ModeWrite, map[string]any{
		"requested_at": now.Add(20 * time.Second).Format(time.RFC3339)}))
	if future.Expired(now, DefaultWindow) {
		t.Fatal("eine leicht vorlaufende Uhr darf nichts verfallen lassen")
	}
}

// Stufe 2 FUEHRT alle drei Lanes aus - und jede bringt genau die Regeln mit,
// die zu IHREM Ziel gehoeren.
func TestAllThreeLanesAreExecutedWithTheirOwnRules(t *testing.T) {
	primary, _ := Parse(order(ModeRead, nil))
	if v := primary.Admissible(); !v.OK() {
		t.Fatalf("die primaere Lane bleibt ausfuehrbar: %+v", v)
	}
	entity, _ := Parse(order(ModeRead, map[string]any{
		"target": map[string]any{"kind": LaneEntity,
			"entity_id": "00000000-0000-0000-0000-0000000000aa"}}))
	if v := entity.Admissible(); !v.OK() {
		t.Fatalf("die Komponenten-Lane wird ausgefuehrt: %+v", v)
	}
	// Ohne Kennung gibt es nichts aufzuloesen - eine kaputte Anfrage, kein
	// Geraete-Problem.
	noID, _ := Parse(order(ModeRead, map[string]any{
		"target": map[string]any{"kind": LaneEntity, "entity_id": "   "}}))
	if v := noID.Admissible(); v.Code != ErrInvalidRequest || v.Message != MsgEntityMissing {
		t.Fatalf("eine Komponente ohne Kennung ist eine kaputte Anfrage: %+v", v)
	}
	lan, _ := Parse(order(ModeRead, map[string]any{
		"target": map[string]any{"kind": LaneLAN, "host": "192.168.0.44"}}))
	if v := lan.Admissible(); !v.OK() {
		t.Fatalf("die freie Lane wird ausgefuehrt: %+v", v)
	}
	unknown, _ := Parse(order(ModeRead, map[string]any{
		"target": map[string]any{"kind": "mond"}}))
	if v := unknown.Admissible(); v.Code != ErrInvalidRequest {
		t.Fatalf("ein unbekanntes Ziel ist eine kaputte Anfrage: %+v", v)
	}
}

// ⚠ Die LAN-Whitelist gilt fuer die EINE Lane, deren Ziel die Cloud benennt -
// und ein nackter Geraetename wird abgelehnt, weil er sich aus der Zeichenkette
// nicht als privat NACHWEISEN laesst.
func TestTheFreeLaneOnlyAcceptsAProvablyPrivateTarget(t *testing.T) {
	for _, host := range []string{"192.168.0.44", "10.1.2.3", "nas.local", "[fd00::1]"} {
		req, _ := Parse(order(ModeRead, map[string]any{
			"target": map[string]any{"kind": LaneLAN, "host": host}}))
		if v := req.Admissible(); !v.OK() {
			t.Fatalf("%q ist belegbar privat: %+v", host, v)
		}
	}
	for _, host := range []string{"8.8.8.8", "example.com", "wechselrichter", ""} {
		req, _ := Parse(order(ModeRead, map[string]any{
			"target": map[string]any{"kind": LaneLAN, "host": host}}))
		if v := req.Admissible(); v.Code != ErrInvalidRequest || v.Message != MsgHostNotPrivate {
			t.Fatalf("%q darf nicht angeklopft werden: %+v", host, v)
		}
	}
}

// ⚠ Die Spulen-Regel ist eine Eigenschaft der LANE, nicht der Box: die
// Solarman-V5-Rahmen kennen nur die Holding-Funktionen, auf schlichtem
// Modbus-TCP gibt es FC1/FC5.
func TestCoilsAreRefusedOnlyWhereTheTransportHasNone(t *testing.T) {
	coil := map[string]any{"kind": KindCoil, "address": 4}
	primary, _ := Parse(order(ModeRead, map[string]any{"register": coil}))
	if v := primary.Admissible(); v.Code != ErrNotSupported || v.Message != MsgCoilNotSupported {
		t.Fatalf("eine Spule ueber den Solarman-Logger geht nicht: %+v", v)
	}
	lan, _ := Parse(order(ModeRead, map[string]any{
		"register": coil,
		"target":   map[string]any{"kind": LaneLAN, "host": "192.168.0.44"}}))
	if v := lan.Admissible(); !v.OK() {
		t.Fatalf("auf Modbus-TCP ist eine Spule ein Objekt wie jedes andere: %+v", v)
	}
	entity, _ := Parse(order(ModeRead, map[string]any{
		"register": coil,
		"target": map[string]any{"kind": LaneEntity,
			"entity_id": "00000000-0000-0000-0000-0000000000aa"}}))
	if v := entity.Admissible(); !v.OK() {
		t.Fatalf("eine Komponente kann eine Spule tragen: %+v", v)
	}
}

// Port und Unit-ID haben die Vorgaben des Kontrakts - und sie leben bei den
// REINEN Regeln, damit die Box genau das waehlt, was hier beurteilt wurde.
func TestTheFreeLaneFallsBackToTheContractDefaults(t *testing.T) {
	bare := Target{Kind: LaneLAN, Host: "192.168.0.44"}
	if bare.EffectivePort() != 502 || bare.EffectiveUnit() != 1 {
		t.Fatalf("Vorgaben 502/1 erwartet, got %d/%d", bare.EffectivePort(), bare.EffectiveUnit())
	}
	port, unit := 1502, 3
	named := Target{Kind: LaneLAN, Host: "192.168.0.44", Port: &port, UnitID: &unit}
	if named.EffectivePort() != 1502 || named.EffectiveUnit() != 3 {
		t.Fatal("genannte Werte gewinnen")
	}
	// Unit 0 ist auf Modbus-TCP eine gueltige Adresse (Broadcast/Gateway) und
	// wird deshalb NICHT auf 1 gehoben.
	zeroUnit := 0
	zero := Target{Kind: LaneLAN, Host: "192.168.0.44", UnitID: &zeroUnit}
	if zero.EffectiveUnit() != 0 {
		t.Fatalf("Unit 0 ist ein Wert, keine Abwesenheit: %d", zero.EffectiveUnit())
	}
}

// Die Selbstkonflikt-Sperre: nur was die LAUFENDE Steuerung wirklich befiehlt,
// wird abgewiesen - und nur, solange sie ueberhaupt schreibt.
func TestControlOwnsOnlyWhatItIsReallyCommanding(t *testing.T) {
	owned := []int{0x044c, 0x044d, 0x00e7}
	if !ControlOwns(true, owned, 0x00e7) {
		t.Fatal("ein befohlenes Register gehoert der Steuerung")
	}
	if ControlOwns(true, owned, 0x00f5) {
		t.Fatal("ein NICHT befohlenes Register ist frei")
	}
	// Ohne laufende Steuerung sind dieselben Register die Installateurs-Domaene.
	if ControlOwns(false, owned, 0x00e7) {
		t.Fatal("bei inaktiver Steuerung darf nichts gesperrt sein")
	}
	if ControlOwns(true, nil, 0x00e7) {
		t.Fatal("ohne Beleg wird nichts behauptet")
	}
}

// Eine Ablehnung traegt NIE einen Wert - sonst laedt sie zu genau der
// „aber da stand doch 3300"-Verwechslung ein, die dieser Kanal vermeidet.
func TestARefusalNeverCarriesAValue(t *testing.T) {
	req, _ := Parse(order(ModeWrite, nil))
	res := Refused(req, ident(), time.Now(), ErrRefusedControlOwned, MsgControlOwned)
	if res.OK || res.BeforeRaw != nil || res.AfterRaw != nil || res.Adopted != nil {
		t.Fatalf("eine Ablehnung darf keinen Wert tragen: %+v", res)
	}
	if res.ErrorCode != ErrRefusedControlOwned || res.Message == "" {
		t.Fatalf("jede Ablehnung nennt Klasse UND Grund: %+v", res)
	}
	if res.Type != TypeResult || res.SchemaVersion != SchemaVersion || res.RequestID != req.RequestID {
		t.Fatalf("der Umschlag muss vertragsfoermig sein: %+v", res)
	}
}

// Die EINGECHECKTEN Kontrakt-Beispiele werden vom ECHTEN Geraete-Parser
// gelesen - per PFAD, damit ein verschobenes Beispiel den Test bricht.
func TestContractExamplesAreParsedAsSpecified(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "..", "docs", "contracts", "examples")
	read := func(name string) []byte {
		t.Helper()
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}

	preview, err := Parse(read("mqtt-register-write.valid.preview.json"))
	if err != nil {
		t.Fatalf("das Vorschau-Beispiel muss parsen: %v", err)
	}
	if preview.Apply() || preview.Register.Address != 231 || preview.Target.Kind != LanePrimary {
		t.Fatalf("Vorschau-Beispiel nicht wie spezifiziert: %+v", preview)
	}

	write, err := Parse(read("mqtt-register-write.valid.write.json"))
	if err != nil {
		t.Fatalf("das Schreib-Beispiel muss parsen: %v", err)
	}
	if !write.Apply() || write.Value == nil || *write.Value != 7000 ||
		write.ExpectedBefore == nil || *write.ExpectedBefore != 3300 ||
		write.Confirm != "0X00E7=7000" || write.WriteFC == nil || *write.WriteFC != 16 {
		t.Fatalf("Schreib-Beispiel nicht wie spezifiziert: %+v", write)
	}
	// Die beiden Beispiele tragen einen FESTEN Stempel, sind also laengst
	// verfallen - und genau das ist richtig so.
	if !write.Expired(time.Now(), DefaultWindow) {
		t.Fatal("ein Beispiel von 2026 darf heute nicht mehr ausfuehrbar sein")
	}

	// Die zwei Lanes der Stufe 2 - beide werden GEPARST und beide sind
	// ausfuehrbar; die Cloud nennt bei der Komponente nur die Kennung.
	entity, err := Parse(read("mqtt-register-write.valid.entity-coil.json"))
	if err != nil {
		t.Fatalf("das Komponenten-Beispiel muss parsen: %v", err)
	}
	if entity.Target.Kind != LaneEntity || entity.Target.EntityID == "" ||
		entity.Target.Host != "" || entity.Register.Kind != KindCoil {
		t.Fatalf("Komponenten-Beispiel nicht wie spezifiziert: %+v", entity)
	}
	if v := entity.Admissible(); !v.OK() {
		t.Fatalf("das Komponenten-Beispiel wird ausgefuehrt: %+v", v)
	}
	lan, err := Parse(read("mqtt-register-write.valid.lan-preview.json"))
	if err != nil {
		t.Fatalf("das LAN-Beispiel muss parsen: %v", err)
	}
	if lan.Apply() || lan.Target.Kind != LaneLAN || lan.Target.Host != "192.168.0.44" ||
		lan.Target.EffectivePort() != 1502 || lan.Target.EffectiveUnit() != 3 {
		t.Fatalf("LAN-Beispiel nicht wie spezifiziert: %+v", lan.Target)
	}
	if v := lan.Admissible(); !v.OK() {
		t.Fatalf("das LAN-Beispiel wird ausgefuehrt: %+v", v)
	}

	if _, err := Parse(read("mqtt-register-write.invalid.write-without-confirm.json")); err == nil {
		t.Fatal("das UNGUELTIGE Beispiel muss abgelehnt werden")
	}
}

func TestTheLimiterBoundsWritesTighterThanReads(t *testing.T) {
	if DefaultRateBudget >= 12 {
		t.Fatal("die Schreib-Grenze muss enger sein als die des Probe-Kanals")
	}
	l := NewLimiter(time.Minute, 2)
	now := time.Now()
	if !l.Allow(now) || !l.Allow(now) {
		t.Fatal("das Budget muss aufgebraucht werden koennen")
	}
	if l.Allow(now) {
		t.Fatal("ueber dem Budget wird abgelehnt")
	}
	// Eine abgelehnte Anfrage verbraucht KEIN Budget - sonst hielte ein
	// wiederholender Aufrufer das Fenster fuer immer offen.
	if !l.Allow(now.Add(61 * time.Second)) {
		t.Fatal("nach dem Fenster muss es weitergehen")
	}
	// Eine nil-Grenze erlaubt alles (der Testpfad ohne Limiter).
	var none *Limiter
	if !none.Allow(now) {
		t.Fatal("ohne Limiter wird nichts abgelehnt")
	}
}

// ⚠ Answerable ist der Zaun um die zwei NEUEN Antworten (Form + Ablauf): sie
// duerfen nur dorthin, wo die Cloud sie auch einordnen KANN. Jede der drei
// Bedingungen ist eine eigene Hausregel, deshalb faellt jede einzeln durch.
func TestAnswerableGuardsEveryConditionOnItsOwn(t *testing.T) {
	id := Identity{TenantID: "t", SiteID: "s", DeviceID: "d"}
	ok := Request{TenantID: "t", SiteID: "s", DeviceID: "d",
		RequestID: "0123456789abcdef", Mode: ModeRead}
	if !ok.Answerable(id) {
		t.Fatal("ein zuordenbarer Auftrag muss beantwortbar sein")
	}
	cases := map[string]Request{
		"fremdes Geraet":       {TenantID: "t", SiteID: "s", DeviceID: "x", RequestID: "0123456789abcdef", Mode: ModeRead},
		"fremder Mandant":      {TenantID: "x", SiteID: "s", DeviceID: "d", RequestID: "0123456789abcdef", Mode: ModeRead},
		"Kennung zu kurz":      {TenantID: "t", SiteID: "s", DeviceID: "d", RequestID: "abc", Mode: ModeRead},
		"Kennung kein Hex":     {TenantID: "t", SiteID: "s", DeviceID: "d", RequestID: "zzzzzzzzzzzzzzzz", Mode: ModeRead},
		"unbekannter Modus":    {TenantID: "t", SiteID: "s", DeviceID: "d", RequestID: "0123456789abcdef", Mode: "malen"},
		"gar keine Identitaet": {RequestID: "0123456789abcdef", Mode: ModeRead},
	}
	for name, r := range cases {
		if r.Answerable(id) {
			t.Fatalf("%s darf NICHT beantwortet werden", name)
		}
	}
	// Und ohne eigene Identitaet beantwortet die Box gar nichts - eine Box, die
	// ihre Cloud-Identitaet noch nicht kennt, kann fuer niemanden sprechen.
	if ok.Answerable(Identity{}) {
		t.Fatal("ohne eigene Identitaet darf nichts beantwortet werden")
	}
}

// Der Ablauf-Satz ist das EINZIGE Signal, an dem eine auseinandergelaufene Uhr
// von einer nachgelieferten Nachricht zu unterscheiden ist - also muss er BEIDE
// Uhren nennen.
func TestExpiredMessageNamesBothClocks(t *testing.T) {
	req := Request{RequestedAt: "2026-08-20T07:11:02Z"}
	now := time.Date(2026, 8, 20, 7, 14, 31, 0, time.UTC)
	msg := ExpiredMessage(req, now, DefaultWindow)
	for _, want := range []string{"2026-08-20T07:11:02Z", "2026-08-20T07:14:31Z", "Uhren"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("der Satz nennt %q nicht: %q", want, msg)
		}
	}
}

// Der Grund des Parsers reist WOERTLICH mit - er ist das Genaueste, was
// irgendwer ueber diesen Auftrag weiss.
func TestInvalidRequestMessageCarriesTheParsersOwnReason(t *testing.T) {
	_, err := Parse([]byte(`{"schema_version":"1.0","type":"register_write_request",` +
		`"request_id":"0123456789abcdef","mode":"schreiben",` +
		`"target":{"kind":"primary"},"register":{"kind":"holding","address":231}}`))
	if err == nil {
		t.Fatal("ein Schreib-Auftrag ohne Wert muss die Form-Pruefung nicht bestehen")
	}
	if msg := MsgInvalidRequest(err); !strings.Contains(msg, err.Error()) {
		t.Fatalf("der Grund fehlt: %q", msg)
	}
	if msg := MsgInvalidRequest(nil); msg == "" {
		t.Fatal("auch ohne Grund muss ein Satz herauskommen")
	}
}
