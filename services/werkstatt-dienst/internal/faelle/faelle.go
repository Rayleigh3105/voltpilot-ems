// Package faelle ist die Tabelle der Fälle an der Werkbank: je Code, was der
// Mensch tun kann (Lösung) und ob der Dienst danach von selbst weitermacht.
// Die Codes stehen in der Ansicht (lauf.fall, anschluss_fall,
// docs/contracts/werkstatt-ansicht-v1.md) und sind Vertrag: nie umbenennen,
// nur neue hinzufügen. Die Texte sind für Fremde an der Werkbank, ohne
// Fachwörter; Technik steht in grund.
package faelle

import "strings"

// Loesung sagt in Alltagsworten, was zu tun ist.
type Loesung struct {
	Titel    string   `json:"titel"`
	Schritte []string `json:"schritte"`
	// Selbst: Nach den Schritten macht der Dienst von selbst weiter (kein Knopf).
	Selbst bool `json:"selbst"`
	// ZurSeite: Die Box kommt zur Seite (Zettel „Problem“), die Technik sieht sie an.
	ZurSeite bool `json:"zur_seite"`
}

// Codes am Anschluss, solange kein Lauf arbeitet (anschluss_fall).
const (
	BrueckeNichtBereit   = "bruecke_nicht_bereit"
	BrueckeUnterspannung = "bruecke_unterspannung"
	KeinKabel            = "kein_kabel"
	KeineBox             = "keine_box"
	NichtFreigegeben     = "nicht_freigegeben"
	ZweiGeraete          = "zwei_geraete" // auch im Lauf
	Startet              = "startet"
	Gesperrt             = "gesperrt"
	Eingerichtet         = "eingerichtet"
)

// Codes eines angehaltenen Laufs (lauf.fall).
const (
	GLPasswort          = "gl_passwort"
	HalbEigene          = "halb_eigene"
	PasswortFremd       = "passwort_fremd"
	BoxInGebrauch       = "box_in_gebrauch"
	NichtNachweisbar    = "nicht_nachweisbar"
	SSHZu               = "ssh_zu"
	AbbildAbgelehnt     = "abbild_abgelehnt"
	FalschesGeraet      = "falsches_geraet"
	SchonEdgeLight      = "schon_edge_light"
	OpenWrtFassung      = "openwrt_fassung"
	KeinInternet        = "kein_internet"
	FassungNichtBereit  = "fassung_nicht_bereit"
	Uebertragung        = "uebertragung"
	BrueckeWeg          = "bruecke_weg"
	BoxWeg              = "box_weg"
	EinloesenAbgewiesen = "einloesen_abgewiesen"
	NichtUpdateBereit   = "nicht_update_bereit"
	DienstNeuGestartet  = "dienst_neu_gestartet"
	SchrittGescheitert  = "schritt_gescheitert"
)

// Codes eines Laufs am WAGO PFC200 (Edge Industrie). Die übrigen Codes gelten
// für beide Geräte; ihre Texte nennt für den PFC200 tabellePFC200.
const (
	// PFCPasswort: Das Werkspasswort wird abgewiesen, und das Gerät gehört
	// nachweislich niemandem (ein unfertiger Lauf dieser Werkstatt): Werksreset.
	PFCPasswort = "pfc_passwort"
	// PFCSchalterStop: Der Betriebsartenschalter steht noch auf STOP (vom
	// Handgriff „feste Adresse“). Der Dienst wartet, bis er auf RUN steht.
	PFCSchalterStop = "pfc_schalter_stop"
	// PFCKabelX1: Das Kabel der Werkbank steckt nicht in der Buchse X2. Nach
	// dem Schritt netze wäre das Gerät an X1 nicht mehr erreichbar. Der
	// Dienst wartet, bis das Kabel in X2 steckt.
	PFCKabelX1 = "pfc_kabel_x1"
	// PFCDockerAn: Der Dienst konnte Docker nicht selbst ausschalten (Schritt
	// docker). Fremde Container, Abbilder und Datenträger fasst er dabei nie
	// an; das Ausschalten von Hand ist der Fallback dieses Falls.
	PFCDockerAn          = "pfc_docker_an"
	PFCFalschesGeraet    = "pfc_falsches_geraet"
	PFCSchonEingerichtet = "pfc_schon_eingerichtet"
	// PFCNotfallSchluessel: Der Notfall-Schlüssel des Dienstes ist Ed25519;
	// der SSH-Dienst des PFC200 nimmt nur RSA und ECDSA.
	PFCNotfallSchluessel = "pfc_notfall_schluessel"
)

const (
	reset    = "Den Reset-Knopf der Mango mit einem Stift 10 Sekunden gedrückt halten, bis die Leuchte schnell blinkt. Dann loslassen."
	bleibt   = "Kabel und Strom bleiben stecken. Die Mango startet neu; das dauert ein paar Minuten."
	kurzAb   = "Das orange Kabel kurz abziehen und wieder einstecken."
	zurSeite = "Zur Seite legen, Zettel „Problem“ drauf. Der Grund bleibt hier für die Technik stehen."
	// Der Startlader antwortet nur an der LAN-Buchse der Mango: Der Rechner
	// steckt dort, wo sonst das orange Kabel steckt (Handgriff M4, mango.startlader).
	rechnerAn    = "Das orange Kabel aus der LAN-Buchse der Mango ziehen. Dort den Rechner per Kabel anstecken."
	startlader   = "Startlader: Mango vom Strom, Reset-Knopf halten und Strom wieder anstecken; loslassen, wenn die Leuchte fünfmal geblinkt hat."
	hochladen    = "Am Rechner das neue System hochladen, wie unter „Details für Technik“ beschrieben."
	kabelZurueck = "Danach das orange Kabel wieder in die LAN-Buchse der Mango stecken."
)

var tabelle = map[string]Loesung{
	BrueckeNichtBereit:   {Titel: "Die Brücke antwortet nicht.", Schritte: []string{"Am Raspberry Pi nachsehen: Strom steckt, die Leuchte ist an.", "Ist das WLAN da? Sonst den Pi kurz vom Strom nehmen und wieder anstecken."}, Selbst: true},
	BrueckeUnterspannung: {Titel: "Die Brücke hat zu wenig Strom.", Schritte: []string{"Die Mango nicht am USB des Raspberry Pi betreiben, sondern an einem eigenen USB-Netzteil.", "Ein stärkeres Netzteil für den Pi nehmen, wenn es wieder kommt."}, Selbst: true},
	KeinKabel:            {Titel: "Kein Kabel am Werkstatt-Anschluss.", Schritte: []string{"Das orange Kabel WERKSTATT in die Buchse LAN der Mango stecken."}, Selbst: true},
	KeineBox:             {Titel: "Am Kabel antwortet noch keine Mango.", Schritte: []string{"Strom an der Mango anstecken; die Leuchte geht an.", "Bis zu einer Minute warten."}, Selbst: true},
	NichtFreigegeben:     {Titel: "Die Werkstatt ist nicht freigegeben.", Schritte: []string{"Ein Admin gibt die Werkstatt in der Übersicht frei. Bis dahin richtet der Dienst keine Box ein."}, Selbst: true},
	ZweiGeraete:          {Titel: "Am Kabel hängen mehrere Geräte.", Schritte: []string{"Nur eine Mango an das orange Kabel. Alles andere abziehen."}, Selbst: true},
	Startet:              {Titel: "Die Mango startet noch.", Schritte: []string{"Nichts tun und nicht abziehen. Der Dienst fängt an, sobald sie fertig gestartet ist."}, Selbst: true},
	Gesperrt:             {Titel: "Diese Box hatte schon ihren Lauf.", Schritte: []string{"Abziehen. Dann die nächste Box einstecken."}, Selbst: true},
	Eingerichtet:         {Titel: "Diese Box ist fertig eingerichtet.", Schritte: []string{"Abziehen. Der Dienst fasst eingerichtete Boxen nicht an."}},

	GLPasswort:          {Titel: "Diese Mango hat schon jemand eingerichtet.", Schritte: []string{reset, bleibt}, Selbst: true},
	HalbEigene:          {Titel: "Diese Mango ist nur halb eingerichtet.", Schritte: []string{reset, bleibt}, Selbst: true},
	PasswortFremd:       {Titel: "Diese Mango gehört nicht zur Werkstatt.", Schritte: []string{"Nicht zurücksetzen.", zurSeite}, ZurSeite: true},
	BoxInGebrauch:       {Titel: "Diese Box ist schon abgenommen oder gekoppelt.", Schritte: []string{"Nicht zurücksetzen.", zurSeite}, ZurSeite: true},
	NichtNachweisbar:    {Titel: "Der Dienst kann nicht sicher sagen, welche Box das ist.", Schritte: []string{"Nicht zurücksetzen.", zurSeite}, ZurSeite: true},
	SSHZu:               {Titel: "Die Mango lässt den Dienst nicht hinein.", Schritte: []string{rechnerAn, startlader, hochladen, kabelZurueck}, Selbst: true},
	AbbildAbgelehnt:     {Titel: "Die Werksfirmware nimmt das neue System nicht an.", Schritte: []string{rechnerAn, startlader, hochladen, kabelZurueck}, Selbst: true},
	FalschesGeraet:      {Titel: "Das ist keine Mango GL-MT300N-V2.", Schritte: []string{zurSeite}, ZurSeite: true},
	SchonEdgeLight:      {Titel: "Auf dieser Mango ist schon VoltPilot.", Schritte: []string{"Nicht zurücksetzen.", zurSeite}, ZurSeite: true},
	OpenWrtFassung:      {Titel: "Auf der Mango ist eine andere System-Fassung.", Schritte: []string{rechnerAn, startlader, hochladen, kabelZurueck}, Selbst: true},
	KeinInternet:        {Titel: "Die Mango kommt nicht ins Internet.", Schritte: []string{"Am Raspberry Pi nachsehen: WLAN da, Router an.", kurzAb}, Selbst: true},
	FassungNichtBereit:  {Titel: "Die Dateien der Freigabe sind nicht bereit.", Schritte: []string{"Die Mango ist noch unverändert. " + zurSeite, "Die Technik prüft Freigabe und Release."}, ZurSeite: true},
	Uebertragung:        {Titel: "Die Übertragung auf die Mango ging schief.", Schritte: []string{kurzAb, "Klappt es wieder nicht: " + zurSeite}, Selbst: true},
	BrueckeWeg:          {Titel: "Die Brücke war während des Laufs weg.", Schritte: []string{"Am Raspberry Pi nachsehen: Strom und WLAN.", kurzAb}, Selbst: true},
	BoxWeg:              {Titel: "Die Mango war während des Laufs weg.", Schritte: []string{"Strom und Kabel der Mango prüfen.", kurzAb}, Selbst: true},
	EinloesenAbgewiesen: {Titel: "Das Portal hat die Box nicht angenommen.", Schritte: []string{zurSeite, "Ist die Freigabe voll oder abgelaufen, gibt ein Admin die Werkstatt neu frei."}, ZurSeite: true},
	NichtUpdateBereit:   {Titel: "Die Box kann keine Updates annehmen.", Schritte: []string{"Nicht versenden. " + zurSeite}, ZurSeite: true},
	DienstNeuGestartet:  {Titel: "Der Dienst wurde mitten im Lauf neu gestartet.", Schritte: []string{kurzAb + " Der Dienst erkennt, wie weit sie war."}, Selbst: true},
	SchrittGescheitert:  {Titel: "Hier hat etwas nicht geklappt.", Schritte: []string{kurzAb + " Der Dienst versucht es noch einmal.", "Klappt es wieder nicht: " + zurSeite}, Selbst: true},
}

// Handgriffe am PFC200, in Alltagsworten. Die Lauf-Seite zeigt je Handgriff ein Bild.
const (
	pfcStrom     = "Strom am PFC200 anstecken. Das orange Kabel steckt in der Buchse X2. Bis zu zwei Minuten warten."
	pfcStop      = "Den Betriebsartenschalter am PFC200 auf STOP stellen."
	pfcResetLang = "Den Reset-Taster (RST) mit einem Stift länger als 8 Sekunden gedrückt halten, bis die Leuchte SYS orange blinkt. Dann loslassen."
	pfcRun       = "Den Betriebsartenschalter wieder auf RUN stellen."
	pfcAdresse   = "Der PFC200 hat jetzt vorübergehend die Adresse 192.168.1.17. Strom und Kabel bleiben stecken: Nach einem Neustart wäre die Adresse wieder weg."
	pfcWerk      = "Werksreset: Den Reset-Taster (RST) gedrückt halten, dabei den Betriebsartenschalter auf RESET drücken und beides halten, bis die Leuchte SYS abwechselnd rot und grün blinkt. Dann loslassen."
	pfcWerkFolge = "Der PFC200 startet neu und ist danach wie ab Werk. Ein SPS-Programm auf dem Gerät ist damit gelöscht."
	pfcKurzAb    = "Das orange Kabel kurz abziehen und wieder in die Buchse X2 stecken."
	pfcNeuAn     = "Hat der PFC200 neu gestartet, ist die feste Adresse weg. Dann: "
)

// tabellePFC200 nennt die Lösungen für einen Lauf am PFC200: die eigenen Codes
// und, wo der Text der Mango nicht passt, eigene Texte für die gemeinsamen.
// Ein Code, der hier fehlt, hat für beide Geräte denselben Text.
var tabellePFC200 = map[string]Loesung{
	PFCPasswort:          {Titel: "Dieser PFC200 ist nur halb eingerichtet.", Schritte: []string{pfcWerk, pfcWerkFolge, pfcStop, pfcResetLang, pfcRun, pfcAdresse}, Selbst: true},
	PFCSchalterStop:      {Titel: "Der Betriebsartenschalter steht auf STOP.", Schritte: []string{pfcRun, "Sonst nichts tun: Der Dienst macht von selbst weiter."}, Selbst: true},
	PFCKabelX1:           {Titel: "Das orange Kabel steckt nicht in der Buchse X2.", Schritte: []string{"Das orange Kabel WERKSTATT in die Buchse X2 des PFC200 stecken. Die Buchse X1 bleibt leer.", "Sonst nichts tun: Der Dienst macht von selbst weiter."}, Selbst: true},
	PFCDockerAn:          {Titel: "Docker ließ sich auf diesem PFC200 nicht automatisch ausschalten.", Schritte: []string{"In der Web-Oberfläche des PFC200 (WBM) unter „Docker“ den Dienst ausschalten. Fremde Container bleiben dabei stehen.", pfcKurzAb + " Der Dienst fängt neu an."}, Selbst: true},
	PFCFalschesGeraet:    {Titel: "Das ist kein PFC200 750-8212.", Schritte: []string{zurSeite}, ZurSeite: true},
	PFCSchonEingerichtet: {Titel: "Auf diesem PFC200 ist schon Edge Industrie.", Schritte: []string{"Nicht zurücksetzen.", zurSeite}, ZurSeite: true},
	PFCNotfallSchluessel: {Titel: "Der Notfall-Schlüssel passt nicht zum PFC200.", Schritte: []string{"Der PFC200 ist noch unverändert. " + zurSeite, "Die Technik hinterlegt einen Notfall-Schlüssel der Art RSA oder ECDSA: Ed25519 nimmt der PFC200 nicht."}, ZurSeite: true},

	KeineBox:            {Titel: "Am Kabel antwortet noch kein PFC200.", Schritte: []string{pfcStrom, "Antwortet er dann nicht, braucht er die feste Adresse: " + pfcStop, pfcResetLang, pfcRun, pfcAdresse}, Selbst: true},
	KeinKabel:           {Titel: "Kein Kabel am Werkstatt-Anschluss.", Schritte: []string{"Das orange Kabel WERKSTATT in die Buchse X2 des PFC200 stecken."}, Selbst: true},
	ZweiGeraete:         {Titel: "Am Kabel hängen mehrere Geräte.", Schritte: []string{"Nur einen PFC200 an das orange Kabel. Alles andere abziehen."}, Selbst: true},
	Startet:             {Titel: "Der PFC200 startet noch.", Schritte: []string{"Nichts tun und nicht abziehen. Der Dienst fängt an, sobald er fertig gestartet ist."}, Selbst: true},
	Gesperrt:            {Titel: "Dieser PFC200 hatte schon seinen Lauf.", Schritte: []string{"Abziehen. Dann das nächste Gerät einstecken."}, Selbst: true},
	Eingerichtet:        {Titel: "Dieser PFC200 ist fertig eingerichtet.", Schritte: []string{"Abziehen. Der Dienst fasst eingerichtete Geräte nicht an."}},
	PasswortFremd:       {Titel: "Dieser PFC200 gehört nicht zur Werkstatt.", Schritte: []string{"Nicht zurücksetzen: Ein Werksreset löscht das SPS-Programm auf dem Gerät.", zurSeite}, ZurSeite: true},
	BoxInGebrauch:       {Titel: "Dieser PFC200 ist schon abgenommen oder gekoppelt.", Schritte: []string{"Nicht zurücksetzen.", zurSeite}, ZurSeite: true},
	NichtNachweisbar:    {Titel: "Der Dienst kann nicht sicher sagen, welcher PFC200 das ist.", Schritte: []string{"Nicht zurücksetzen: Ein Werksreset löscht das SPS-Programm auf dem Gerät.", zurSeite}, ZurSeite: true},
	KeinInternet:        {Titel: "Der PFC200 kommt nicht ins Internet.", Schritte: []string{"Am Raspberry Pi nachsehen: WLAN da, Router an.", pfcKurzAb}, Selbst: true},
	FassungNichtBereit:  {Titel: "Die Dateien der Freigabe sind nicht bereit.", Schritte: []string{"Der PFC200 ist noch unverändert. " + zurSeite, "Die Technik prüft Freigabe und Release."}, ZurSeite: true},
	Uebertragung:        {Titel: "Die Übertragung auf den PFC200 ging schief.", Schritte: []string{pfcKurzAb, "Klappt es wieder nicht: " + zurSeite}, Selbst: true},
	BrueckeWeg:          {Titel: "Die Brücke war während des Laufs weg.", Schritte: []string{"Am Raspberry Pi nachsehen: Strom und WLAN.", pfcKurzAb}, Selbst: true},
	BoxWeg:              {Titel: "Der PFC200 war während des Laufs weg.", Schritte: []string{"Strom und Kabel des PFC200 prüfen.", pfcKurzAb, pfcNeuAn + pfcStop, pfcResetLang, pfcRun}, Selbst: true},
	NichtUpdateBereit:   {Titel: "Der PFC200 kann keine Updates annehmen.", Schritte: []string{"Nicht versenden. " + zurSeite}, ZurSeite: true},
	EinloesenAbgewiesen: {Titel: "Das Portal hat den PFC200 nicht angenommen.", Schritte: []string{zurSeite, "Ist die Freigabe voll oder abgelaufen, gibt ein Admin die Werkstatt neu frei."}, ZurSeite: true},
	DienstNeuGestartet:  {Titel: "Der Dienst wurde mitten im Lauf neu gestartet.", Schritte: []string{pfcKurzAb + " Der Dienst erkennt, wie weit er war."}, Selbst: true},
	SchrittGescheitert:  {Titel: "Hier hat etwas nicht geklappt.", Schritte: []string{pfcKurzAb + " Der Dienst versucht es noch einmal.", "Klappt es wieder nicht: " + zurSeite}, Selbst: true},
}

// AmAnschluss gibt die Lösung zu einem Fall am Anschluss, solange kein Lauf
// arbeitet. Richtet der Dienst auch PFC200 ein (mitPFC200), nennt sie für
// „kein Kabel“ und „niemand antwortet“ beide Geräte: Ein PFC200 ab Werk hat
// ohne den Handgriff „feste Adresse“ keine Adresse, der Dienst kann ihn dann
// nicht von „nichts steckt“ unterscheiden. Darum steht der Handgriff dort immer.
func AmAnschluss(code string, mitPFC200 bool) *Loesung {
	l := Zu(code)
	if l == nil || !mitPFC200 {
		return l
	}
	switch code {
	case KeinKabel:
		l.Schritte = []string{"Das orange Kabel WERKSTATT einstecken: bei der Mango in die Buchse LAN, beim PFC200 in die Buchse X2."}
	case KeineBox:
		l.Titel = "Am Kabel antwortet noch kein Gerät."
		l.Schritte = []string{
			"Mango: Strom anstecken, die Leuchte geht an. Bis zu einer Minute warten.",
			"PFC200: Strom anstecken und bis zu zwei Minuten warten. Antwortet er dann nicht, braucht er die feste Adresse.",
			"PFC200, feste Adresse: " + pfcStop, pfcResetLang, pfcRun, pfcAdresse,
		}
	case ZweiGeraete:
		l.Schritte = []string{"Nur ein Gerät an das orange Kabel. Alles andere abziehen."}
	}
	return l
}

// GeraetPFC200 ist das Wort für den PFC200 in box_art (freigabe.PFC200).
const GeraetPFC200 = "pfc200"

// ZuFuer gibt die Lösung zu einem Code für ein Gerät (box_art eines Laufs):
// für den PFC200 seine eigenen Texte, sonst und für jeden Code ohne eigenen
// Text die der Mango. nil für einen unbekannten Code.
func ZuFuer(geraet, code string) *Loesung {
	if geraet == GeraetPFC200 {
		if l, ok := tabellePFC200[code]; ok {
			l.Schritte = append([]string(nil), l.Schritte...)
			return &l
		}
	}
	return Zu(code)
}

// Zu gibt die Lösung zu einem Code (eine Kopie); nil für einen unbekannten.
func Zu(code string) *Loesung {
	l, ok := tabelle[code]
	if !ok {
		// Ein Code, den es nur am PFC200 gibt.
		if l, ok = tabellePFC200[code]; !ok {
			return nil
		}
	}
	l.Schritte = append([]string(nil), l.Schritte...)
	return &l
}

// Codes gibt alle Codes (für Tests und die Doku).
func Codes() []string {
	var c []string
	for k := range tabelle {
		c = append(c, k)
	}
	for k := range tabellePFC200 {
		if _, ok := tabelle[k]; !ok {
			c = append(c, k)
		}
	}
	return c
}

// Einordnen gibt den Code für einen Fehler ohne eigenen Fall: aus dem Schritt
// und dem Grund. Unbekanntes wird schritt_gescheitert.
func Einordnen(schritt, grund string) string {
	switch {
	case strings.Contains(grund, "Brücke") && strings.Contains(grund, "nicht erreichbar"):
		return BrueckeWeg
	case strings.Contains(grund, "mehrere Geräte"):
		return ZweiGeraete
	case schritt == "internet" && strings.Contains(grund, "kein Internet"):
		return KeinInternet
	case schritt == "fassungen":
		return FassungNichtBereit
	case schritt == "openwrt" && strings.Contains(grund, "Prüfsumme"):
		return Uebertragung
	case schritt == "einloesen" && (strings.Contains(grund, "abgewiesen") || strings.Contains(grund, "Einmal-Code")):
		return EinloesenAbgewiesen
	case strings.Contains(grund, "nicht update-bereit"):
		return NichtUpdateBereit
	case strings.Contains(grund, "No route to host") || strings.Contains(grund, "antwortet nicht") ||
		strings.Contains(grund, "i/o timeout") || strings.Contains(grund, "abgerissen"):
		return BoxWeg
	}
	return SchrittGescheitert
}

// nochmal sind die Fälle eines Laufs, die das Portal mit „Nochmal versuchen“
// neu anstoßen darf (Entscheid E1 A der Lauf-Seite): kein Handgriff an der
// Box, nichts wird gelöscht. Der Auftrag tut dasselbe wie das orange Kabel
// kurz abzuziehen: Der Dienst gibt die Sperre der Box frei und beginnt neu.
// Reset, Startlader und „zur Seite“ stehen nie darin.
var nochmal = map[string]bool{
	PFCDockerAn:        true,
	KeinInternet:       true,
	Uebertragung:       true,
	BrueckeWeg:         true,
	BoxWeg:             true,
	ZweiGeraete:        true,
	DienstNeuGestartet: true,
	SchrittGescheitert: true,
	NichtNachweisbar:   true,
}

// Nochmal sagt, ob ein angehaltener Lauf mit diesem Fall aus dem Portal neu
// angestoßen werden darf.
func Nochmal(code string) bool { return nochmal[code] }
