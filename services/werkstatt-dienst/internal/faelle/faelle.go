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

const (
	reset      = "Den Reset-Knopf der Mango mit einem Stift 10 Sekunden gedrückt halten, bis die Leuchte schnell blinkt. Dann loslassen."
	bleibt     = "Kabel und Strom bleiben stecken. Die Mango startet neu; das dauert ein paar Minuten."
	kurzAb     = "Das orange Kabel kurz abziehen und wieder einstecken."
	zurSeite   = "Zur Seite legen, Zettel „Problem“ drauf. Der Grund bleibt hier für die Technik stehen."
	startlader = "Startlader: Mango vom Strom, Reset-Knopf halten und Strom wieder anstecken; nach etwa fünf Sekunden loslassen, wenn die Leuchte blinkt."
	hochladen  = "Am Rechner das neue System hochladen, wie unter „Details für Technik“ beschrieben. Das orange Kabel bleibt stecken."
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
	SSHZu:               {Titel: "Die Mango lässt den Dienst nicht hinein.", Schritte: []string{startlader, hochladen}, Selbst: true},
	AbbildAbgelehnt:     {Titel: "Die Werksfirmware nimmt das neue System nicht an.", Schritte: []string{startlader, hochladen}, Selbst: true},
	FalschesGeraet:      {Titel: "Das ist keine Mango GL-MT300N-V2.", Schritte: []string{zurSeite}, ZurSeite: true},
	SchonEdgeLight:      {Titel: "Auf dieser Mango ist schon VoltPilot.", Schritte: []string{"Nicht zurücksetzen.", zurSeite}, ZurSeite: true},
	OpenWrtFassung:      {Titel: "Auf der Mango ist eine andere System-Fassung.", Schritte: []string{startlader, hochladen}, Selbst: true},
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

// Zu gibt die Lösung zu einem Code (eine Kopie); nil für einen unbekannten.
func Zu(code string) *Loesung {
	l, ok := tabelle[code]
	if !ok {
		return nil
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
