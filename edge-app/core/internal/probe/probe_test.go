package probe

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func mustParse(t *testing.T, payload []byte) Request {
	t.Helper()
	req, err := Parse(payload)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	return req
}

const (
	tenant = "00000000-0000-0000-0000-000000000001"
	site   = "00000000-0000-0000-0000-000000000002"
	device = "00000000-0000-0000-0000-000000000003"
)

func ownIdentity() Identity {
	return Identity{TenantID: tenant, SiteID: site, DeviceID: device}
}

func contractPath(name string) string {
	return filepath.Join("..", "..", "..", "..", "docs", "contracts", "examples", name)
}

// The committed contract fixtures are read BY PATH by the REAL device-side
// parser - moving or renaming one breaks this test deliberately.
func TestContractExamplesAreParsedAsSpecified(t *testing.T) {
	raw, err := os.ReadFile(contractPath("mqtt-probe.valid.read.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	req := mustParse(t, raw)
	if !req.Matches(ownIdentity()) {
		t.Fatalf("fixture identity should match the fixture's own device")
	}
	if len(req.Ops) != 2 {
		t.Fatalf("want 2 ops, got %d", len(req.Ops))
	}
	if code, _ := ValidateOp(req.Ops[0]); code != "" {
		t.Fatalf("first op should be executable, got %q", code)
	}
	// Defaults applied where the fixture omits them.
	if req.Ops[1].EffectivePort() != 502 || req.Ops[1].EffectiveUnit() != 1 {
		t.Fatalf("defaults not applied: port=%d unit=%d",
			req.Ops[1].EffectivePort(), req.Ops[1].EffectiveUnit())
	}
	if req.Ops[1].EffectiveWordOrder() != "little" {
		t.Fatalf("word order lost: %q", req.Ops[1].EffectiveWordOrder())
	}
	// scale/offset are DISPLAY-only and must survive verbatim.
	if got := req.Ops[1].Scaled(3000); got < 26.84 || got > 26.86 {
		t.Fatalf("scaling lost: %v", got)
	}

	// The two WRITING ops parse and are ADMITTED (Einheitsmodell Stufe 4), and
	// the defaults the contract states are the ones the box would really use.
	for _, name := range []string{"mqtt-probe.valid.switch-test.json",
		"mqtt-probe.valid.switch-setpoint.json", "mqtt-probe.valid.switch-cancel.json"} {
		raw, err = os.ReadFile(contractPath(name))
		if err != nil {
			t.Fatalf("read fixture %s: %v", name, err)
		}
		sw := mustParse(t, raw)
		if code, msg := ValidateOp(sw.Ops[0]); code != "" {
			t.Fatalf("%s must be admitted, got %q %q", name, code, msg)
		}
		if !sw.Ops[0].Writes() {
			t.Fatalf("%s: a switch op must report that it writes", name)
		}
	}
	raw, err = os.ReadFile(contractPath("mqtt-probe.valid.switch-test.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	coil := mustParse(t, raw).Ops[0]
	// A coil defaults to FC5 - it is not stated in the fixture, and guessing a
	// register function code would address a different register file entirely.
	if got := coil.EffectiveWriteFC(); got != WriteFCCoil {
		t.Fatalf("coil default write fc: want %d, got %d", WriteFCCoil, got)
	}
	if got := coil.EffectiveTTL(); got != 30 {
		t.Fatalf("ttl: want 30, got %d", got)
	}
	raw, err = os.ReadFile(contractPath("mqtt-probe.invalid.switch-test-without-ttl.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	noTTL := mustParse(t, raw)
	if code, _ := ValidateOp(noTTL.Ops[0]); code != ErrInvalidRequest {
		t.Fatalf("a switch test without ttl must be invalid_request, got %q", code)
	}

	// The RESULT fixture is the answer shape the cloud consumes; parsing it
	// back pins that the failed line carries no value and the ok line carries
	// raw AND value.
	raw, err = os.ReadFile(contractPath("mqtt-probe.valid.result.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var res Result
	if err := json.Unmarshal(raw, &res); err != nil {
		t.Fatalf("result fixture: %v", err)
	}
	if res.Type != TypeResult || len(res.Results) != 2 {
		t.Fatalf("unexpected result fixture shape: %+v", res)
	}
	if res.Results[0].Raw == nil || res.Results[0].Value == nil {
		t.Fatalf("an ok line must carry raw AND value")
	}
	if res.Results[1].Value != nil || res.Results[1].Raw != nil {
		t.Fatalf("a failed line must carry NO value")
	}
	if res.Results[1].ErrorCode == "" {
		t.Fatalf("a failed line must carry a named class")
	}

	// The invalid fixture must not survive the real parser's op validation
	// either: an op without a data type cannot be executed.
	raw, err = os.ReadFile(contractPath("mqtt-probe.invalid.read-without-data-type.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	bad := mustParse(t, raw)
	if code, _ := ValidateOp(bad.Ops[0]); code != ErrInvalidRequest {
		t.Fatalf("a read without data_type must be invalid_request, got %q", code)
	}
}

func TestParseRefusesUnknownForms(t *testing.T) {
	cases := []struct {
		name    string
		payload string
	}{
		{"empty", ""},
		{"not json", "nope"},
		{"wrong schema version", `{"schema_version":"2.0","type":"probe_request","request_id":"0011223344556677","ops":[{}]}`},
		{"wrong type", `{"schema_version":"1.0","type":"probe_result","request_id":"0011223344556677","ops":[{}]}`},
		{"no request id", `{"schema_version":"1.0","type":"probe_request","ops":[{}]}`},
		{"request id too short", `{"schema_version":"1.0","type":"probe_request","request_id":"00112233","ops":[{}]}`},
		{"request id not hex", `{"schema_version":"1.0","type":"probe_request","request_id":"zzzzzzzzzzzzzzzz","ops":[{}]}`},
		{"no ops", `{"schema_version":"1.0","type":"probe_request","request_id":"0011223344556677","ops":[]}`},
	}
	for _, c := range cases {
		if _, err := Parse([]byte(c.payload)); err == nil {
			t.Fatalf("%s: expected refusal", c.name)
		}
	}
	// More ops than the contract allows.
	ops := make([]map[string]any, MaxOps+1)
	for i := range ops {
		ops[i] = map[string]any{"op": "read"}
	}
	body, _ := json.Marshal(map[string]any{
		"schema_version": "1.0", "type": "probe_request",
		"request_id": "0011223344556677", "requested_at": "2026-08-11T09:00:00Z",
		"ops": ops,
	})
	if _, err := Parse(body); err == nil {
		t.Fatalf("expected the op-count bound to bite")
	}
}

func TestIdentityMustBeOurOwn(t *testing.T) {
	base := map[string]any{
		"schema_version": "1.0", "type": "probe_request",
		"tenant_id": tenant, "site_id": site, "device_id": device,
		"request_id": "0011223344556677", "requested_at": "2026-08-11T09:00:00Z",
		"ops": []map[string]any{{"op": "read"}},
	}
	raw, _ := json.Marshal(base)
	if !mustParse(t, raw).Matches(ownIdentity()) {
		t.Fatalf("own identity should match")
	}
	// Case-insensitive: a UUID is a UUID however it is written.
	base["device_id"] = "00000000-0000-0000-0000-000000000003"
	up := map[string]any{}
	for k, v := range base {
		up[k] = v
	}
	up["tenant_id"] = "00000000-0000-0000-0000-000000000001"
	raw, _ = json.Marshal(up)
	if !mustParse(t, raw).Matches(ownIdentity()) {
		t.Fatalf("case should not matter")
	}
	for _, field := range []string{"tenant_id", "site_id", "device_id"} {
		other := map[string]any{}
		for k, v := range base {
			other[k] = v
		}
		other[field] = "99999999-9999-9999-9999-999999999999"
		raw, _ = json.Marshal(other)
		if mustParse(t, raw).Matches(ownIdentity()) {
			t.Fatalf("a foreign %s must not match", field)
		}
	}
	// Before the cloud identity is known, nothing matches.
	raw, _ = json.Marshal(base)
	if mustParse(t, raw).Matches(Identity{}) {
		t.Fatalf("an empty identity must never match")
	}
}

func TestExpiryCountsFromTheEnvelopeStampNotArrival(t *testing.T) {
	now := time.Date(2026, 8, 11, 9, 0, 0, 0, time.UTC)
	mk := func(stamp string) Request {
		return Request{RequestedAt: stamp}
	}
	if mk(now.Format(time.RFC3339)).Expired(now, DefaultWindow) {
		t.Fatalf("a fresh request must not be expired")
	}
	if mk(now.Add(-DefaultWindow+time.Second).Format(time.RFC3339)).Expired(now, DefaultWindow) {
		t.Fatalf("just inside the window must not be expired")
	}
	// THE case this exists for: a QoS1 redelivery after a long outage.
	if !mk(now.Add(-time.Hour).Format(time.RFC3339)).Expired(now, DefaultWindow) {
		t.Fatalf("a redelivered hour-old request must be expired")
	}
	// An unreadable stamp counts as expired - in doubt nothing is read.
	if !mk("gestern").Expired(now, DefaultWindow) {
		t.Fatalf("an unreadable stamp must count as expired")
	}
	if !mk("").Expired(now, DefaultWindow) {
		t.Fatalf("a missing stamp must count as expired")
	}
	// A FUTURE stamp is not expired: the two clocks are independent and the
	// portal is actively waiting.
	if mk(now.Add(30*time.Second).Format(time.RFC3339)).Expired(now, DefaultWindow) {
		t.Fatalf("a slightly future stamp must stay executable")
	}
}

func readOp(host string) Op {
	port, unit, addr := 502, 1, 100
	return Op{
		Op: OpRead, ID: "kanal-1", Transport: TransportModbusTCP, Host: host,
		Port: &port, UnitID: &unit, RegisterKind: "holding", Address: &addr,
		DataType: "u16",
	}
}

func TestOnlyPrivateTargetsAreProbed(t *testing.T) {
	private := []string{
		"192.168.0.28", "10.0.7.19", "172.16.5.4", "172.31.255.255",
		"127.0.0.1", "169.254.10.10", "100.72.0.1",
		"::1", "fd00::1", "fe80::1", "[fd00::5]",
		"wr1.local", "logger.lan", "box.home.arpa", "gw.internal",
		"192.168.0.28.",
	}
	for _, h := range private {
		if !IsPrivateHost(h) {
			t.Fatalf("%q should count as a private target", h)
		}
		if code, _ := ValidateOp(readOp(h)); code != "" {
			t.Fatalf("%q should be executable, got %q", h, code)
		}
	}
	public := []string{
		"1.1.1.1", "8.8.8.8", "172.32.0.1", "9.255.255.255", "100.128.0.1",
		"2001:4860:4860::8888", "example.com", "portal.voltpilot.de",
		"", "   ", "http://192.168.0.1", "192.168.0.1:502", "user@192.168.0.1",
		// ⚠ A BARE hostname is refused on purpose: it is resolved by whatever
		// search domains the box happens to carry, so it cannot be shown to be
		// private from the string - and a whitelist that cannot prove its own
		// promise is not one. The refusal names the way out (type the IP).
		"wechselrichter", "logger",
	}
	for _, h := range public {
		if IsPrivateHost(h) {
			t.Fatalf("%q must NOT count as a private target", h)
		}
		code, msg := ValidateOp(readOp(h))
		if code != ErrInvalidRequest {
			t.Fatalf("%q should be refused, got %q", h, code)
		}
		if msg == "" {
			t.Fatalf("%q was refused without a sentence", h)
		}
	}
}

func TestValidateOpRefusalsAreNamedAndOrdered(t *testing.T) {
	// An unknown op type is answered as "this box cannot", never as "broken
	// request" - even when its other fields would also be wrong.
	unknown := readOp("192.168.0.28")
	unknown.Op = "erfinde-etwas"
	if code, _ := ValidateOp(unknown); code != ErrNotSupported {
		t.Fatalf("an unknown op must be not_supported, got %q", code)
	}
	// A transport the box does not drive is a statement about the BOX.
	other := readOp("192.168.0.28")
	other.Transport = "solarman_v5"
	if code, _ := ValidateOp(other); code != ErrNotSupported {
		t.Fatalf("an unsupported transport must be not_supported, got %q", code)
	}

	bad := func(mut func(*Op)) string {
		op := readOp("192.168.0.28")
		mut(&op)
		code, msg := ValidateOp(op)
		if msg == "" {
			t.Fatalf("refusal without a sentence")
		}
		return code
	}
	high, low := 70000, -1
	checks := []struct {
		name string
		mut  func(*Op)
	}{
		{"no id", func(o *Op) { o.ID = "" }},
		{"bad id", func(o *Op) { o.ID = "Kanal 1" }},
		{"no host", func(o *Op) { o.Host = "  " }},
		{"port out of range", func(o *Op) { o.Port = &high }},
		{"unit out of range", func(o *Op) { o.UnitID = &low }},
		{"unknown register kind", func(o *Op) { o.RegisterKind = "coil" }},
		{"no address", func(o *Op) { o.Address = nil }},
		{"address out of range", func(o *Op) { o.Address = &high }},
		{"no data type", func(o *Op) { o.DataType = "" }},
		{"unknown data type", func(o *Op) { o.DataType = "u64" }},
		{"unknown word order", func(o *Op) { o.WordOrder = "mixed" }},
	}
	for _, c := range checks {
		if got := bad(c.mut); got != ErrInvalidRequest {
			t.Fatalf("%s: want invalid_request, got %q", c.name, got)
		}
	}
	// input registers (FC4) are executable too.
	in := readOp("192.168.0.28")
	in.RegisterKind = "input"
	if code, _ := ValidateOp(in); code != "" {
		t.Fatalf("input registers must be executable, got %q", code)
	}
}

func TestScalingIsDisplayOnly(t *testing.T) {
	op := readOp("192.168.0.28")
	// Neither stated: raw == value, the honest reading of "no scaling asked".
	if got := op.Scaled(1234); got != 1234 {
		t.Fatalf("unscaled must pass through: %v", got)
	}
	s, off := 0.1, -5.0
	op.Scale, op.Offset = &s, &off
	if got := op.Scaled(1000); got < 94.99 || got > 95.01 {
		t.Fatalf("scale/offset: %v", got)
	}
	// A zero scale is a legitimate (if odd) request, not a division trap.
	zero := 0.0
	op.Scale, op.Offset = &zero, nil
	if got := op.Scaled(1000); got != 0 {
		t.Fatalf("zero scale: %v", got)
	}
}

func TestResultShapeIsHonest(t *testing.T) {
	req := Request{RequestID: "0011223344556677"}
	now := time.Date(2026, 8, 11, 9, 0, 2, 0, time.UTC)
	res := NewResult(req, ownIdentity(), now, []OpResult{
		Succeeded("a", 94, []int{94}, 9.4),
		Failed("b", ErrNoAnswer, "Das Gerät antwortet nicht."),
	})
	if res.SchemaVersion != SchemaVersion || res.Type != TypeResult {
		t.Fatalf("envelope: %+v", res)
	}
	if res.DeviceID != device || res.RequestID != req.RequestID {
		t.Fatalf("identity/correlation: %+v", res)
	}
	if res.AnsweredAt != "2026-08-11T09:00:02Z" {
		t.Fatalf("answered_at: %q", res.AnsweredAt)
	}
	if res.Results[1].Value != nil || res.Results[1].Raw != nil {
		t.Fatalf("a failed line must never carry a value")
	}
	// An empty result set serializes as [] and not as null - a consumer must
	// not have to tell "no lines" from "the field is missing".
	empty := NewResult(req, ownIdentity(), now, nil)
	raw, _ := json.Marshal(empty)
	if want := `"results":[]`; !strings.Contains(string(raw), want) {
		t.Fatalf("empty results must serialize as []: %s", raw)
	}

	refused := Refused(req, ownIdentity(), now, ErrRateLimited, RateLimitedMessage)
	if refused.ErrorCode != ErrRateLimited || refused.Message == "" {
		t.Fatalf("a whole-request refusal must name itself: %+v", refused)
	}
	if len(refused.Results) != 0 {
		t.Fatalf("a refused request executed nothing, so it answers nothing per op")
	}
}

func TestLimiterBoundsBurstsAndLiftsWithTime(t *testing.T) {
	now := time.Date(2026, 8, 11, 9, 0, 0, 0, time.UTC)
	l := NewLimiter(time.Minute, 3)
	for i := 0; i < 3; i++ {
		if !l.Allow(now) {
			t.Fatalf("request %d should fit the budget", i)
		}
	}
	if l.Allow(now) {
		t.Fatalf("the fourth request must be refused")
	}
	// A refused request must NOT consume budget - otherwise a retrying client
	// holds the window open forever.
	if l.Allow(now.Add(time.Second)) {
		t.Fatalf("still inside the window")
	}
	// Once the window slides past the first hits, the budget frees up again.
	if !l.Allow(now.Add(61 * time.Second)) {
		t.Fatalf("the window must lift")
	}
	// Zero/negative arguments never build an unlimited limiter.
	d := NewLimiter(0, 0)
	for i := 0; i < DefaultRateBudget; i++ {
		if !d.Allow(now) {
			t.Fatalf("default budget too small at %d", i)
		}
	}
	if d.Allow(now) {
		t.Fatalf("default budget must bound")
	}
}

func TestLimiterIsConcurrencySafe(t *testing.T) {
	now := time.Now()
	l := NewLimiter(time.Minute, 50)
	done := make(chan bool, 100)
	for i := 0; i < 100; i++ {
		go func() { done <- l.Allow(now) }()
	}
	allowed := 0
	for i := 0; i < 100; i++ {
		if <-done {
			allowed++
		}
	}
	if allowed != 50 {
		t.Fatalf("exactly the budget must pass, got %d", allowed)
	}
}

func TestValidateOpsAddsTheCrossOpUniquenessRule(t *testing.T) {
	a := readOp("192.168.0.28")
	a.ID = "soc"
	b := readOp("192.168.0.29")
	b.ID = "soc"
	c := readOp("192.168.0.30")
	c.ID = "leistung"
	bad := readOp("8.8.8.8")
	bad.ID = "extern"

	v := ValidateOps([]Op{a, b, c, bad})
	if !v[0].OK() {
		t.Fatalf("the FIRST occurrence keeps the name: %+v", v[0])
	}
	if v[1].Code != ErrInvalidRequest || v[1].Message == "" {
		t.Fatalf("a duplicate id must be refused BY NAME: %+v", v[1])
	}
	if !v[2].OK() {
		t.Fatalf("an unrelated op must stay executable: %+v", v[2])
	}
	if v[3].Code != ErrInvalidRequest {
		t.Fatalf("the per-op rules still bind: %+v", v[3])
	}
	// A refused op must NOT claim its id - otherwise a later, valid op with the
	// same name would inherit the refusal.
	again := readOp("192.168.0.31")
	again.ID = "extern"
	v = ValidateOps([]Op{bad, again})
	if v[0].OK() || !v[1].OK() {
		t.Fatalf("a refused op must not burn its id: %+v", v)
	}
	if len(ValidateOps(nil)) != 0 {
		t.Fatalf("no ops, no verdicts")
	}
}

// --- Stufe 1: der Verbindungstest, verallgemeinert auf ALLE Transporte ------

func TestTestConnectionCarriesTheSamePrivateTargetRuleAsARegisterRead(t *testing.T) {
	// Die Regel existiert, damit ein Portal-Fehler die Flotte nie zu einem
	// Portscanner macht - welcher Op-Typ fragt, ist ihr egal.
	code, msg := ValidateOp(Op{
		Op: OpTestConnection, ID: "verbindung", Brand: "deye",
		Connection: []byte(`{"ip":"8.8.8.8","port":8899}`),
	})
	if code != ErrInvalidRequest || !strings.Contains(msg, "eigenen Netz") {
		t.Fatalf("code=%q msg=%q", code, msg)
	}
	code, _ = ValidateOp(Op{
		Op: OpTestConnection, ID: "verbindung", Brand: "deye",
		Connection: []byte(`{"ip":"192.168.0.28","port":8899}`),
	})
	if code != "" {
		t.Fatalf("ein privates Ziel muss durchgehen, code=%q", code)
	}
}

func TestTestConnectionRefusesWhatItCannotEvenAddress(t *testing.T) {
	cases := []struct {
		name string
		op   Op
		want string
	}{
		{"ohne Marke", Op{Op: OpTestConnection, ID: "a",
			Connection: []byte(`{"ip":"192.168.0.5"}`)}, "Marke"},
		{"ohne Verbindung", Op{Op: OpTestConnection, ID: "a", Brand: "deye"}, "Verbindungsdaten"},
		{"ohne Adresse", Op{Op: OpTestConnection, ID: "a", Brand: "deye",
			Connection: []byte(`{"port":8899}`)}, "Adresse"},
		// Ein NACKTER Hostname laesst sich aus der Zeichenkette nicht als
		// privat belegen - dieselbe Whitelist-Disziplin wie beim Register-Read.
		{"nackter Hostname", Op{Op: OpTestConnection, ID: "a", Brand: "deye",
			Connection: []byte(`{"ip":"wechselrichter"}`)}, "eigenen Netz"},
	}
	for _, c := range cases {
		code, msg := ValidateOp(c.op)
		if code != ErrInvalidRequest || !strings.Contains(msg, c.want) {
			t.Fatalf("%s: code=%q msg=%q", c.name, code, msg)
		}
	}
}

func TestConnectionHostNeverReportsAnEmptyStringAsATarget(t *testing.T) {
	if h, ok := ConnectionHost([]byte(`{"ip":"  "}`)); ok || h != "" {
		t.Fatalf("h=%q ok=%v", h, ok)
	}
	if _, ok := ConnectionHost([]byte(`kein json`)); ok {
		t.Fatal("unlesbare Verbindungsdaten nennen kein Ziel")
	}
	h, ok := ConnectionHost([]byte(`{"ip":"192.168.0.28","port":8899}`))
	if !ok || h != "192.168.0.28" {
		t.Fatalf("h=%q ok=%v", h, ok)
	}
}

func TestTheTestConnectionContractFixturesParseAndAdmit(t *testing.T) {
	raw, err := os.ReadFile(contractPath("mqtt-probe.valid.test-connection.json"))
	if err != nil {
		t.Fatalf("Fixture: %v", err)
	}
	req, err := Parse(raw)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if len(req.Ops) != 1 || req.Ops[0].Op != OpTestConnection || req.Ops[0].Brand != "deye" {
		t.Fatalf("ops = %+v", req.Ops)
	}
	if v := ValidateOps(req.Ops); !v[0].OK() {
		t.Fatalf("die Fixture muss zugelassen werden: %+v", v[0])
	}

	raw, err = os.ReadFile(contractPath("mqtt-probe.valid.test-connection-result.json"))
	if err != nil {
		t.Fatalf("Ergebnis-Fixture: %v", err)
	}
	var res Result
	if err := json.Unmarshal(raw, &res); err != nil {
		t.Fatalf("Ergebnis unlesbar: %v", err)
	}
	if len(res.Results) != 1 || !res.Results[0].OK || res.Results[0].Reading == nil ||
		res.Results[0].Reading.PvKw == nil || *res.Results[0].Reading.PvKw != 12.4 {
		t.Fatalf("Ergebnis = %+v", res.Results)
	}
	// Ein Kanal, den das Geraet nicht meldet, FEHLT - er ist nie 0.
	line := SucceededReading("verbindung", &Reading{PvKw: res.Results[0].Reading.PvKw})
	out, _ := json.Marshal(line)
	if strings.Contains(string(out), "load_kw") {
		t.Fatalf("ein nicht gemeldeter Kanal darf nicht in den Draht: %s", out)
	}

	// Die EHRLICHE Ablehnung (Live-Fall Muehlfeldweg 2, 21.08.2026): die Box hat
	// wirklich gelesen, drei Kanaele sind sauber dekodiert, und NUR der Ladestand
	// hat die Plausibilitaetsregel verletzt. Dann traegt die Ablehnung beides -
	// die Werte, die ankamen, und den benannten Befund. Ohne das war sie ein
	// Raetsel, an dem eine reale Neuanlage haengengeblieben ist.
	raw, err = os.ReadFile(contractPath("mqtt-probe.valid.test-connection-implausible.json"))
	if err != nil {
		t.Fatalf("Befund-Fixture: %v", err)
	}
	var bad Result
	if err := json.Unmarshal(raw, &bad); err != nil {
		t.Fatalf("Befund-Ergebnis unlesbar: %v", err)
	}
	l := bad.Results[0]
	if l.OK || l.ErrorCode != ErrImplausible {
		t.Fatalf("die Zeile muss eine benannte Ablehnung sein: %+v", l)
	}
	if l.Reading == nil || l.Reading.PvKw == nil || *l.Reading.PvKw != 6.1 {
		t.Fatalf("die gelesenen Werte muessen mitreisen: %+v", l.Reading)
	}
	if l.Reading.SocPct != nil {
		t.Fatalf("der verletzende Kanal darf NIE im reading stehen: %+v", l.Reading)
	}
	if l.Finding == nil || l.Finding.Channel != "soc_pct" || l.Finding.Rule != "missing" {
		t.Fatalf("der Befund muss Kanal UND Regel benennen: %+v", l.Finding)
	}
	if l.Finding.Value == nil || *l.Finding.Value != 0 {
		t.Fatalf("der verletzende Wert gehoert in den Befund: %+v", l.Finding)
	}
	// Raw/Value der ZEILE bleiben weg - die gehoeren einer Register-Lesung.
	if l.Raw != nil || l.Value != nil {
		t.Fatalf("eine Ablehnung traegt nie raw/value: %+v", l)
	}
	// Die SCHAETZUNG neben dem Befund: sie fehlt hier, weil dieses Geraet keine
	// Eckpunkte gepflegt hat - eine Schaetzung wird nie erfunden.
	if l.Finding.Estimate != nil {
		t.Fatalf("ohne gepflegte Eckpunkte gibt es keine Schaetzung: %+v", l.Finding.Estimate)
	}

	// ... und die Variante MIT Schaetzung (Batteriemodus "User defined": das BMS
	// meldet nichts, die Klemmenspannung ist aber messbar). Sie aendert das
	// URTEIL nicht - die Zeile bleibt eine benannte Ablehnung mit derselben
	// Regel, damit die Anlage weiterhin die ausdrueckliche Zustimmung des
	// Kunden braucht und fuer die Batterie-Steuerung gesperrt bleibt.
	raw, err = os.ReadFile(contractPath("mqtt-probe.valid.test-connection-soc-estimate.json"))
	if err != nil {
		t.Fatalf("Schaetzungs-Fixture: %v", err)
	}
	var est Result
	if err := json.Unmarshal(raw, &est); err != nil {
		t.Fatalf("Schaetzungs-Ergebnis unlesbar: %v", err)
	}
	e := est.Results[0]
	if e.OK || e.ErrorCode != ErrImplausible {
		t.Fatalf("eine Schaetzung macht aus der Ablehnung KEIN Ja: %+v", e)
	}
	if e.Finding == nil || e.Finding.Rule != "missing" {
		t.Fatalf("die Regel bleibt unveraendert: %+v", e.Finding)
	}
	if e.Finding.Estimate == nil {
		t.Fatal("die Schaetzung muss neben dem Befund mitreisen")
	}
	if e.Finding.Estimate.SocPct != 36 || e.Finding.Estimate.VoltageV != 636 {
		t.Fatalf("Prozent UND Spannung gehoeren dazu - ohne die Spannung waere die "+
			"Zahl unpruefbar: %+v", e.Finding.Estimate)
	}
	if e.Reading == nil || e.Reading.SocPct != nil {
		t.Fatalf("auch eine Schaetzung steht NIE im reading: %+v", e.Reading)
	}
}

// TestSwitchAdmissionCarriesEveryReadRuleAndItsOwn is the safety heart of the
// writing ops: everything a READ must satisfy still holds (the reason the
// private-target rule exists does not care which op asks - and a write is the
// one that matters most), plus the rules only a write has.
func TestSwitchAdmissionCarriesEveryReadRuleAndItsOwn(t *testing.T) {
	base := func() Op {
		p, u, a := 502, 2, 7
		on, off, ttl := 1, 0, 30
		return Op{Op: OpSwitchTest, ID: "relais", Transport: TransportModbusTCP,
			Host: "192.168.0.28", Port: &p, UnitID: &u, RegisterKind: RegisterKindCoil,
			Address: &a, OnValue: &on, OffValue: &off, TTLSeconds: &ttl}
	}
	if code, _ := ValidateOp(base()); code != "" {
		t.Fatalf("the baseline switch test must be admitted, got %q", code)
	}

	ptr := func(v int) *int { return &v }
	cases := []struct {
		name string
		mut  func(*Op)
		want string
	}{
		// The read rules, re-applied.
		{"public target is refused", func(o *Op) { o.Host = "8.8.8.8" }, ErrInvalidRequest},
		{"a bare hostname cannot be proven private", func(o *Op) { o.Host = "relais" }, ErrInvalidRequest},
		{"no host at all", func(o *Op) { o.Host = "  " }, ErrInvalidRequest},
		{"an unsupported transport is about the BOX", func(o *Op) { o.Transport = "solarman_v5" }, ErrNotSupported},
		{"port out of range", func(o *Op) { o.Port = ptr(0) }, ErrInvalidRequest},
		{"unit out of range", func(o *Op) { o.UnitID = ptr(999) }, ErrInvalidRequest},
		{"address out of range", func(o *Op) { o.Address = ptr(70000) }, ErrInvalidRequest},
		// The write-only rules.
		{"an input register cannot be written", func(o *Op) { o.RegisterKind = "input" }, ErrInvalidRequest},
		{"a coil knows only 0 and 1", func(o *Op) { o.OnValue = ptr(300) }, ErrInvalidRequest},
		{"FC6 does not write a coil", func(o *Op) { o.WriteFC = ptr(WriteFCSingle) }, ErrInvalidRequest},
		{"an unknown function code", func(o *Op) { o.WriteFC = ptr(3) }, ErrInvalidRequest},
		{"no value to write", func(o *Op) { o.OnValue = nil }, ErrInvalidRequest},
		{"no safe value to fall back to", func(o *Op) { o.OffValue = nil }, ErrInvalidRequest},
		{"no test duration means no auto-off", func(o *Op) { o.TTLSeconds = nil }, ErrInvalidRequest},
		{"a test longer than the ceiling", func(o *Op) { o.TTLSeconds = ptr(MaxSwitchTTL + 1) }, ErrInvalidRequest},
		{"a test of zero seconds", func(o *Op) { o.TTLSeconds = ptr(0) }, ErrInvalidRequest},
		{"readback address out of range", func(o *Op) { o.ReadbackAddress = ptr(70000) }, ErrInvalidRequest},
	}
	for _, c := range cases {
		op := base()
		c.mut(&op)
		if code, msg := ValidateOp(op); code != c.want {
			t.Errorf("%s: want %q, got %q", c.name, c.want, code)
		} else if msg == "" {
			t.Errorf("%s: a refusal without a sentence is a riddle", c.name)
		}
	}

	// FC5 on a holding register addresses a different register file.
	reg := base()
	reg.RegisterKind = RegisterKindHolding
	reg.WriteFC = ptr(WriteFCCoil)
	if code, _ := ValidateOp(reg); code != ErrInvalidRequest {
		t.Fatalf("FC5 on a holding register must be refused, got %q", code)
	}
	// A holding register defaults to FC16, NOT FC6 - the documented
	// "accepted but not adopted" lesson.
	reg.WriteFC = nil
	reg.OnValue, reg.OffValue = ptr(3000), ptr(0)
	if code, _ := ValidateOp(reg); code != "" {
		t.Fatalf("a setpoint test must be admitted, got %q", code)
	}
	if got := reg.EffectiveWriteFC(); got != WriteFCMultiple {
		t.Fatalf("holding default write fc: want %d, got %d", WriteFCMultiple, got)
	}

	// A cancel writes ONLY the off value - it carries neither an on value nor a
	// duration, because it has no auto-off to arm.
	cancel := base()
	cancel.Op = OpSwitchCancel
	cancel.OnValue, cancel.TTLSeconds = nil, nil
	if code, _ := ValidateOp(cancel); code != "" {
		t.Fatalf("a cancel must be admitted, got %q", code)
	}
	if cancel.EffectiveTTL() != 0 {
		t.Fatalf("a cancel has no ttl")
	}
	withOn := cancel
	withOn.OnValue = ptr(1)
	if code, _ := ValidateOp(withOn); code != ErrInvalidRequest {
		t.Fatalf("a cancel carrying an on value must be refused, got %q", code)
	}
}

// TestSwitchResultNeverClaimsAReadbackItDidNotTake pins the honesty of the
// answer shape: a readback that was not performed is ABSENT, never a "does not
// match", and a write NEVER travels as a measurement.
func TestSwitchResultNeverClaimsAReadbackItDidNotTake(t *testing.T) {
	ttl := 30
	res := SucceededSwitch("relais", 1, &ttl, nil)
	if res.Switched == nil || res.Switched.Written != 1 {
		t.Fatalf("the written value must be reported verbatim: %#v", res.Switched)
	}
	if res.Switched.Readback != nil || res.Switched.ReadbackMatches != nil {
		t.Fatalf("a readback that never happened must be absent")
	}
	if res.Raw != nil || res.Value != nil || res.Reading != nil {
		t.Fatalf("a write must never dress up as a measurement")
	}
	if got := *res.Switched.OffAfterSeconds; got != 30 {
		t.Fatalf("off_after_s: want 30, got %d", got)
	}

	match := SucceededSwitch("relais", 1, nil, &[]int{1}[0])
	if !*match.Switched.ReadbackMatches {
		t.Fatalf("an equal readback matches")
	}
	miss := SucceededSwitch("relais", 1, nil, &[]int{0}[0])
	if *miss.Switched.ReadbackMatches {
		t.Fatalf("a differing readback must not claim a match")
	}
	if miss.Switched.OffAfterSeconds != nil {
		t.Fatalf("a cancel reports no auto-off")
	}
}
