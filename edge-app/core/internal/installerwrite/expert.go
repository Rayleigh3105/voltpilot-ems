package installerwrite

// Der EXPERTEN-Umfang der Politik (Konzept `vp-reg-schreib-konzept-p8` §2.8
// Stufe 2 „Freie Register", Captain-Vorentscheidung 1: „Freie Register-Eingabe
// ist der Kern, NICHT nur ein kuratierter Katalog").
//
// ⚠ ER LÖST DIE HARTE 0x00E7-ALLOWLIST FÜR DEN PORTAL-KANAL AB - angekündigt,
// nicht unterlaufen. Der Vorgänger-PR schrieb selbst: „ein künftiges ‚nur noch
// ein Register' ist eine Code-Änderung hier, mit eigenem Review". Das ist dieser
// Code, und dies ist sein Review.
//
// ⚠ ES BLEIBEN ZWEI UMFÄNGE IN EINER SCHICHT, KEINE ZWEITE POLITIK:
//
//	Admit       (installerwrite.go)  der ENGE Umfang der :8484-Wartungstaste -
//	                                 GENAU das Export-Limit-Register, Deckel
//	                                 7000, kW-Kopie. Ihre Oberfläche ist ein
//	                                 Werkzeug für EINE Zahl und bleibt es.
//	AdmitExpert (hier)               der Umfang des PORTAL-Kanals - freies
//	                                 Holding-Register bzw. freie Spule, Wert
//	                                 0..65535 (Spule 0/1).
//
// Beide bauen DIESELBE `AdmittedWrite` (unexportierte Felder, ein einziger
// Mechanismus dahinter) und teilen die tragenden Regeln WÖRTLICH: den
// Bestätigungs-Token, die `expected_before`-Schranke und die Einmaligkeit. Es
// gibt weiterhin keinen Weg an einer Admit-Funktion vorbei.
//
// ⚠ WAS DER FREIE UMFANG NICHT AUFGIBT (die Schutzstufen des Konzepts §2.9,
// alle woanders und alle weiter bindend): die Vorschau-PFLICHT (der Ist-Wert
// wird über DIESELBE Lane gelesen, bevor ein Mensch bestätigt - dort wird ein
// Adress- oder Skalenfehler SICHTBAR), die `expected_before`-Wache, die
// Selbstkonflikt-Sperre (`internal/registerwrite`), das Feature-Gate, die
// Ratenbegrenzung, GENAU EIN Schreibversuch und das doppelt geführte Journal.
// Der Schutz kommt aus INFORMATION statt aus einer Sperre - das ist die
// Captain-Entscheidung, und sie trägt nur, weil diese sechs Dinge stehen.

// ExpertRequest ist die schon geformte Anfrage des Portal-Kanals. Sie kommt
// AUSSCHLIESSLICH aus `internal/registerwrite` (das Form, Identität, Verfall,
// Lane und Rate bereits entschieden hat); die Felder heißen deshalb wie dort.
type ExpertRequest struct {
	// Kind ist KindHolding oder KindCoil.
	Kind string
	// Addr ist die 0-basierte, dezimal normalisierte Adresse (0..65535).
	Addr int
	// Value ist das ROHE Registerwort. Bei einer Spule sind 0 und 1 die einzigen
	// zulässigen Werte - alles andere ist ein Anfrage-Fehler, kein Geräte-Fehler.
	Value int
	// Apply unterscheidet den Probelauf von dem EINEN Schreibvorgang.
	Apply bool
	// Confirm muss ConfirmToken(Addr, Value) entsprechen, wenn Apply gilt.
	Confirm string
	// ExpectedBefore ist die optionale Wache (nil = keine).
	ExpectedBefore *int
	// WriteFC pinnt den Modbus-Schreib-Funktionscode (0 = der Ausführer
	// entscheidet: Spule -> 5, Holding -> 16).
	WriteFC int
	// Scale ist eine BEKANNTE Skala des Registers (Rohwert × Scale = kW), sonst
	// nil. Sie ist reine ANZEIGE und stammt aus dem Register-Wissen der Box -
	// niemals aus der Anfrage: eine mitgeschickte Skala wäre eine Behauptung des
	// Aufrufers über ein fremdes Gerät.
	Scale *float64
}

// Die erlaubten Schreib-Funktionscodes. FC16 ist die Vorauswahl fürs Holding-
// Register (die belegte Deye-/Fronius-Lektion „FC6 wird angenommen, aber nicht
// übernommen"), FC5 die einzige Form für eine Spule.
const (
	WriteFCCoil     = 5
	WriteFCSingle   = 6
	WriteFCMultiple = 16
)

// AdmitExpert ist der ZWEITE (und letzte) Konstruktor einer `AdmittedWrite`.
// Er urteilt über FORM und WERTEBEREICH - nie über „ist diese Adresse sinnvoll":
// das ist genau die Freiheit, die diese Stufe herstellt, und ihr Gegenmittel ist
// die Vorschau plus das Register-Wissen der Cloud, nicht eine Liste hier.
func AdmitExpert(req ExpertRequest) (AdmittedWrite, error) {
	kind := req.Kind
	if kind == "" {
		kind = KindHolding
	}
	if kind != KindHolding && kind != KindCoil {
		return AdmittedWrite{}, refuse("Es gibt nur Holding-Register und Spulen (angefragt: %q).", req.Kind)
	}
	if req.Addr < 0 || req.Addr > maxRegisterWord {
		return AdmittedWrite{}, refuse("Die Adresse %d ist kein Register (0 bis %d).", req.Addr, maxRegisterWord)
	}
	if req.Value < 0 || req.Value > maxRegisterWord {
		return AdmittedWrite{}, refuse("Der Wert %d ist kein Registerwort (0 bis %d).", req.Value, maxRegisterWord)
	}
	// ⚠ Eine Spule KENNT nur zwei Zustände. Ein 300 dort ist ein Anfrage-Fehler,
	// und ihn erst das Gerät ablehnen zu lassen hieße, einen Schreibrahmen für
	// eine Zahl hinauszuschicken, die es gar nicht geben kann.
	if kind == KindCoil && req.Value != 0 && req.Value != 1 {
		return AdmittedWrite{}, refuse("Eine Spule kennt nur 0 und 1 (angefragt: %d).", req.Value)
	}
	if err := checkWriteFC(kind, req.WriteFC); err != nil {
		return AdmittedWrite{}, err
	}
	if req.ExpectedBefore != nil && (*req.ExpectedBefore < 0 || *req.ExpectedBefore > maxRegisterWord) {
		return AdmittedWrite{}, refuse("Der erwartete Ist-Wert %d ist kein Registerwert (0 bis %d).",
			*req.ExpectedBefore, maxRegisterWord)
	}
	if req.Apply {
		want := ConfirmToken(req.Addr, req.Value)
		if !equalFold(req.Confirm, want) {
			return AdmittedWrite{}, refuse("Zum Schreiben wird die ausdrückliche Bestätigung %q benötigt.", want)
		}
	}
	w := AdmittedWrite{
		register: HexLabel(req.Addr),
		kind:     kind,
		addr:     req.Addr,
		value:    req.Value,
		writeFC:  req.WriteFC,
		apply:    req.Apply,
	}
	// Eine bekannte Skala wandert als reine ANZEIGE mit; ein Register ohne
	// bekannte Skala bekommt KEINE erfundene Einheit.
	if req.Scale != nil {
		kw := float64(req.Value) * *req.Scale
		w.kw = &kw
	}
	if req.ExpectedBefore != nil {
		v := *req.ExpectedBefore
		w.expectedBefore = &v
	}
	return w, nil
}

// checkWriteFC hält den Funktionscode und die Registerart zusammen. Ein FC5 auf
// ein Holding-Register (oder ein FC16 auf eine Spule) ist keine Vorliebe,
// sondern ein Widerspruch - und ein Widerspruch, den erst das Gerät bemerkt,
// kostet einen Schreibrahmen.
func checkWriteFC(kind string, fc int) error {
	if fc == 0 {
		return nil // der Ausführer entscheidet
	}
	if kind == KindCoil {
		if fc != WriteFCCoil {
			return refuse("Eine Spule wird mit FC5 geschrieben (angefragt: FC%d).", fc)
		}
		return nil
	}
	if fc != WriteFCSingle && fc != WriteFCMultiple {
		return refuse("Ein Holding-Register wird mit FC6 oder FC16 geschrieben (angefragt: FC%d).", fc)
	}
	return nil
}
