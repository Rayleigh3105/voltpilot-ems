package pfc200

// Die Texte, die ein Mensch an der Werkbank oder im Portal liest, stehen hier
// an einer Stelle. Der PFC200 heißt als Box „Edge Industrie“ (die Mango: Edge
// Light); das Gerät selbst heißt weiter PFC200.

// Name ist der Name der Box-Software auf dem PFC200.
const Name = "Edge Industrie"

// Titel der Schritte.
const (
	titelErkennen         = "PFC200 erkennen"
	titelErkennenHalb     = "Halb eingerichteten PFC200 erkennen"
	titelFassungen        = "Fassungen der Freigabe bereitlegen"
	titelInternet         = "Internet über die Brücke (befristet) und Uhr stellen"
	titelZugaenge         = "Zugänge: drei Passwörter, Anmeldung nur noch mit Schlüssel"
	titelNotfall          = "Notfall-Schlüssel"
	titelProgramm         = Name + " einspielen"
	titelTunnelSchluessel = "Tunnel-Schlüssel erzeugen"
	titelEinloesen        = "Einmal-Code einlösen"
	titelTunnelAdresse    = "Tunnel-Adresse aus dem Portal"
	titelTunnel           = "Tunnel einrichten"
	titelNetze            = "Netze trennen und Firewall einschalten"
	titelNeustart         = "Neustart-Probe"
	titelProbe            = "Probe im Fenster"
	titelInternetWeg      = "Werkstatt-Internet und Lauf-Schlüssel entfernen"
	titelUebergabe        = "Belege für die Abnahme"
)

// Handgriffe, wie sie im Lauf stehen (lauf.handgriff). Die Lösung in
// Alltagsworten steht in internal/faelle. Exportiert, weil der Vektor der
// Ansicht (internal/dienst, Zustände eines Laufs am PFC200) dieselben Sätze
// zeigt wie der echte Lauf.
const (
	ZurSeite = "PFC200 abziehen und zur Seite legen; den Grund im Portal oder beim Betreiber melden."
	// Werksreset ist der eine Handgriff für einen PFC200, in den der Dienst
	// nicht hineinkommt, den er aber zurücksetzen lassen darf: ein Gerät, das
	// diese Werkstatt begonnen und nicht fertig gemacht hat. Danach ist das
	// Gerät wie ab Werk und wartet wieder auf eine Adresse.
	Werksreset = "Werksreset: Den Reset-Taster (RST) gedrückt halten, dabei den Betriebsartenschalter auf RESET drücken und beides halten, bis die Leuchte SYS abwechselnd rot und grün blinkt; dann loslassen. " +
		"Der PFC200 startet neu und ist danach wie ab Werk. Danach die feste Adresse geben: " + FesteAdresseHandgriff
	// FesteAdresseHandgriff gibt dem PFC200 vorübergehend die Adresse 192.168.1.17.
	FesteAdresseHandgriff = "Betriebsartenschalter auf STOP, Reset-Taster (RST) länger als 8 Sekunden halten, bis die Leuchte SYS orange blinkt, dann den Schalter wieder auf RUN."
	SchalterAufRun        = "Den Betriebsartenschalter des PFC200 auf RUN stellen. Der Dienst macht von selbst weiter."
	KabelInX2             = "Das orange Kabel WERKSTATT in die Buchse X2 des PFC200 stecken, die Buchse X1 bleibt leer. Der Dienst macht von selbst weiter."
	DockerAus             = "In der Web-Oberfläche des PFC200 (WBM) unter „Docker“ den Dienst ausschalten, wenn die Container nicht gebraucht werden. Dann das orange Kabel kurz abziehen."
)

// Sätze an der Abnahme und auf der Abschlussseite.
const (
	// HinweisZugaenge sagt, wo die Passwörter stehen und wie der Betreiber an
	// das von admin kommt (er braucht es für CODESYS und die Web-Oberfläche).
	HinweisZugaenge = "Die Passwörter von root, admin und user stehen nur verschlüsselt an der Abnahme, für den age-Schlüssel „Box-Passwörter“. " +
		"Für CODESYS und die Web-Oberfläche des PFC200 (Benutzer admin) entschlüsselst du sie selbst: age -d -i <Schlüssel Box-Passwörter>. Entschlüsselt steht je Zugang eine Zeile da."
	// HinweisCodesys sagt, wo CODESYS nach dem Lauf anliegt.
	HinweisCodesys = "CODESYS erreicht den PFC200 nur an der Buchse X2 (Anlagennetz). Zum Kundennetz an X1 sind Entwicklungsumgebung, Web-Oberfläche und SSH zu."
	// HinweisVersand ist der Satz zum Versand (Entscheid 5c), wie bei der Mango.
	HinweisVersand = "Nicht versenden: erst nach dem Laborbeweis und dem ersten Update über das Portal (Entscheid 5c, U-6)"
)

// HinweisTunnel sagt, was der Betreiber ohne API für die Tunnel-Adresse tut.
func HinweisTunnel(ref, pub string) string {
	return "Im Portal unter Geräte › Fernwartung „Tunnel-Schlüssel hinterlegen“: Referenz " + ref + ", Schlüssel " + pub +
		". Dann die zugeteilte Adresse eintragen: kubectl -n werkstatt-prod exec deploy/werkstatt-dienst -- vp-werkstatt-dienst eingabe tunnel_adresse <adresse>"
}

// HinweisProbe sagt, was der Betreiber ohne API für die Probe im Fenster tut.
func HinweisProbe(ref, host string) string {
	return "Im Portal unter Geräte › Werkstatt bei " + ref + ": Fenster „Werkstatt-Probe“ öffnen, dich durch den Tunnel anmelden, den Host-Schlüssel lesen (hier im Netz gelesen: " + host +
		"), das Fenster schließen und den abgewiesenen Versuch machen. Dann: kubectl -n werkstatt-prod exec deploy/werkstatt-dienst -- vp-werkstatt-dienst eingabe probe erledigt"
}
