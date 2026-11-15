package steuerart

// Die Schreibform der Übersetzung: dieselben Regeln für Text und Kommentar wie die
// Übersetzung einer Regel (regel/schreiber.go), damit jeder YAML-Leser jeden
// Text als denselben Text liest.

import (
	"regexp"
	"strconv"
	"strings"
)

type schreiber struct {
	b strings.Builder
}

func (s *schreiber) zeile(einzug int, text string) {
	if text == "" {
		s.b.WriteString("\n")
		return
	}
	s.b.WriteString(strings.Repeat(" ", einzug) + text + "\n")
}

// kommentar schreibt einen Satz als Kommentarzeilen, umbrochen nach etwa 110 Zeichen.
func (s *schreiber) kommentar(einzug int, text string) {
	zeile := "#"
	for _, w := range strings.Fields(text) {
		if len([]rune(zeile))+1+len([]rune(w)) > 110 && zeile != "#" {
			s.zeile(einzug, zeile)
			zeile = "#"
		}
		zeile += " " + w
	}
	if zeile != "#" {
		s.zeile(einzug, zeile)
	}
}

var (
	jaNeinWort  = regexp.MustCompile(`^(?i:y|n|yes|no|true|false|on|off|null|~)$`)
	zahlMuster  = regexp.MustCompile(`^[-+]?(\.\d+|\d+(\.\d*)?)([eE][-+]?\d+)?$`)
	zeitMuster  = regexp.MustCompile(`^\d{1,2}:\d{2}`)
	kommaZahl   = regexp.MustCompile(`^\d+,\d+$`)
	sicherPlain = regexp.MustCompile(`^[^-?:,\[\]{}#&*!|>'"%@` + "`" + `\s]`)
)

// skalar schreibt einen Text so, dass jeder YAML-Leser ihn als denselben Text liest; fluss
// heißt: er steht in einer Klammer {…} und darf kein Komma tragen.
func skalar(t string, fluss bool) string {
	braucht := t == "" || !sicherPlain.MatchString(t) || strings.Contains(t, ": ") || strings.Contains(t, " #") ||
		strings.HasSuffix(t, ":") || strings.HasSuffix(t, " ") || jaNeinWort.MatchString(t) || zahlMuster.MatchString(t) ||
		zeitMuster.MatchString(t) || strings.ContainsAny(t, "\n\t\"") || kommaZahl.MatchString(t)
	if fluss && strings.ContainsAny(t, ",[]{}") {
		braucht = true
	}
	if !braucht {
		return t
	}
	if !strings.ContainsAny(t, "'\n\t") {
		return "'" + t + "'"
	}
	return strconv.Quote(t)
}
