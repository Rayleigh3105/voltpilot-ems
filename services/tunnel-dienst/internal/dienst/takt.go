package dienst

import "time"

// Anlauf: Gleich nach dem Start der VM scheitert der erste Abruf, weil das
// Netz noch keine Adresse hat (unter Debian 13 mit dhcpcd ist
// network-online.target erreicht, bevor DHCP geantwortet hat). Statt ein
// ganzes Abrufintervall zu warten, versucht es der Dienst in dieser Lage ein
// paar Mal in kurzem Abstand - ein Fenster, das vor dem Neustart offen war,
// geht so nach Sekunden wieder auf statt nach einem halben Intervall mehr.
const (
	AnlaufPause    = 5 * time.Second
	AnlaufVersuche = 5
)

// Takt bestimmt den Abstand zwischen zwei Läufen.
type Takt struct {
	Intervall time.Duration

	erfolg   bool
	versuche int
}

// Naechster liefert den Abstand vom Beginn des gerade beendeten Laufs bis zum
// Beginn des nächsten. Kürzer als das Intervall ist er nur, solange seit dem
// Start noch kein Abruf gelungen ist, der Grund eine unerreichbare API war
// und die schnellen Versuche nicht aufgebraucht sind. Eine abgelehnte
// Anmeldung vergeht nicht von selbst und wird nicht schneller wiederholt.
func (t *Takt) Naechster(e Ergebnis) time.Duration {
	if !e.APIFehlt {
		// Alles außer einer unerreichbaren API beendet den Anlauf: ein
		// gelungener Abruf ebenso wie eine Störung, die nicht am Netz liegt.
		t.erfolg = true
	}
	if t.erfolg || t.versuche >= AnlaufVersuche || AnlaufPause >= t.Intervall {
		return t.Intervall
	}
	t.versuche++
	return AnlaufPause
}
