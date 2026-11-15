package homeassistant

// Automationen und Skripte. Home Assistant wertet eine Automation aus, wenn ein Auslöser
// sie weckt; der Kern prüft jede Bedingung in jedem Takt (Bericht 3.7, 14.3). Übersetzt
// wird deshalb, was gelten muss, damit die Automation etwas tut: ihre Bedingungen, dazu
// ein Auslöser mit "for:" als holds(), und der Auslöser selbst nur, wenn ihn keine
// Bedingung und kein Auffanglauf (time_pattern) abdeckt. Was die Automation tut, wird
// zur Bedingung eines Zustands, zum Schritt eines Zählers oder zum Ausgang eines Geräts.

import (
	"fmt"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

type wirkung struct {
	art    string // bool_an, bool_aus, um, setze, timer_start, timer_stop, schalter_an, schalter_aus
	symbol *symbol
	bed    *ir
	um     int
	setze  *ir
	dauer  *ir
	ort    Ort
}

type ausloeser struct {
	art    string // raster, start, ebene, weck
	ebene  *ir
	halte  *ir
	dauer  float64
	raster float64
	ort    Ort
	text   string
}

// mitAuswerter ruft f mit einem Auswerter für Bedingungen und fängt "nicht übersetzbar".
func (u *uebersetzer) mitAuswerter(o Ort, env umgebung, f func(a *auswerter) *ir) (e *ir, st *Stelle) {
	a := &auswerter{u: u, ort: Ort{Datei: o.Datei, Zeile: o.Zeile}, naechste: &u.naechste}
	defer func() {
		if r := recover(); r != nil {
			if nf, ok := r.(nichtUebersetzbar); ok {
				st = &Stelle{Ort: Ort{Datei: o.Datei, Zeile: o.Zeile + nf.zeile}, Grund: nf.grund}
				return
			}
			panic(r)
		}
	}()
	return f(a), nil
}

// vorlageWert wertet eine Vorlage zu genau einem Wert aus (Bedingung, Dauer, Liste von Zielen).
func (u *uebersetzer) vorlageWert(datei string, n *yaml.Node, env umgebung) (wert, *Stelle) {
	var kopie umgebung
	if env != nil {
		kopie = env.kopie()
	}
	aus, f := u.werteMit(datei, n, "", kopie)
	u.gibOffen(nil)
	if f != nil {
		return wert{}, f
	}
	if len(aus) != 1 || !aus[0].bed.istWahr(true) {
		e, grund := u.wertVon(aus, false)
		if grund == "" {
			return wert{art: 'z', e: e}, nil
		}
		e, grund = u.wertVon(aus, true)
		if grund == "" {
			return wert{art: 'b', e: e}, nil
		}
		return wert{}, &Stelle{Ort: Ort{Datei: datei, Zeile: n.Line}, Grund: "die Vorlage liefert je nach Fall verschiedene Werte, die sich nicht zusammenführen lassen"}
	}
	return aus[0].w, nil
}

func (u *uebersetzer) vorlageBedingung(datei string, n *yaml.Node, env umgebung) (*ir, *Stelle) {
	w, f := u.vorlageWert(datei, n, env)
	if f != nil {
		return nil, f
	}
	return u.mitAuswerter(Ort{Datei: datei, Zeile: n.Line}, env, func(a *auswerter) *ir { return a.wahrheit(w) })
}

// wertOderEntity: eine Zahl, eine Entität (input_number, Messwert) oder eine Vorlage.
func (u *uebersetzer) wertOderEntity(a *auswerter, datei string, n *yaml.Node, env umgebung) *ir {
	t := text(n)
	if v, err := strconv.ParseFloat(strings.TrimSpace(t), 64); err == nil {
		return zahl(v, nil)
	}
	if IstVorlage(t) {
		w, f := u.vorlageWert(datei, n, env)
		if f != nil {
			a.stopp("%s", f.Grund)
		}
		return a.zahlWert(w)
	}
	e, _ := u.zahlVon(a, t)
	return e
}

func entities(n *yaml.Node) []string {
	var ids []string
	for _, e := range liste(n) {
		for _, t := range strings.Split(text(e), ",") {
			if t = strings.TrimSpace(t); t != "" {
				ids = append(ids, t)
			}
		}
	}
	return ids
}

// bedingung übersetzt eine Bedingung von Home Assistant.
func (u *uebersetzer) bedingung(datei string, n *yaml.Node, env umgebung) (*ir, *Stelle) {
	o := Ort{Datei: datei, Zeile: n.Line}
	if n.Kind == yaml.ScalarNode {
		return u.vorlageBedingung(datei, n, env)
	}
	art := text(feld(n, "condition"))
	if art == "" {
		for _, k := range []string{"and", "or", "not"} {
			if feld(n, k) != nil {
				art = k
			}
		}
	}
	switch art {
	case "template":
		return u.vorlageBedingung(datei, erstesFeld(n, "value_template"), env)
	case "and", "or", "not":
		var teile []*ir
		kinder := liste(erstesFeld(n, "conditions", art))
		for _, k := range kinder {
			e, f := u.bedingung(datei, k, env)
			if f != nil {
				return nil, f
			}
			teile = append(teile, e)
		}
		switch art {
		case "and":
			return und(teile...), nil
		case "or":
			return oder(teile...), nil
		}
		return nicht(oder(teile...)), nil
	case "state":
		if feld(n, "attribute") != nil {
			return nil, &Stelle{Ort: o, Grund: "eine Bedingung auf ein Attribut lässt sich nicht übersetzen"}
		}
		e, f := u.mitAuswerter(o, env, func(a *auswerter) *ir {
			var alle []*ir
			for _, id := range entities(feld(n, "entity_id")) {
				var eines []*ir
				for _, z := range liste(feld(n, "state")) {
					eines = append(eines, u.zustandIst(a, id, text(z)))
				}
				alle = append(alle, oder(eines...))
			}
			if text(feld(n, "match")) == "any" {
				return oder(alle...)
			}
			return und(alle...)
		})
		if f != nil {
			return nil, f
		}
		if d := feld(n, "for"); d != nil {
			s, ok := dauerSekunden(d)
			if !ok {
				return nil, &Stelle{Ort: o, Grund: "die Dauer von „for“ lässt sich nicht lesen"}
			}
			e = aufruf("holds", nil, e, zahl(s, neueGroesse(gDauer, "s")))
		}
		return e, nil
	case "numeric_state":
		if feld(n, "value_template") != nil {
			return nil, &Stelle{Ort: o, Grund: "numeric_state mit value_template lässt sich nicht übersetzen; schreiben Sie eine Vorlage-Bedingung"}
		}
		return u.mitAuswerter(o, env, func(a *auswerter) *ir { return u.numerisch(a, datei, n, env) })
	case "time":
		if feld(n, "weekday") != nil {
			return nil, &Stelle{Ort: o, Grund: "Wochentage übernimmt der Übersetzer nicht; in der Logik ist das ein Stellwert der Art Zeitplan"}
		}
		return u.mitAuswerter(o, env, func(a *auswerter) *ir {
			nach, vor := feld(n, "after"), feld(n, "before")
			zeit := func(x *yaml.Node) *ir {
				t := text(x)
				if strings.Contains(t, ".") {
					return u.uhrzeitVon(a, t)
				}
				return &ir{art: 'u', text: uhrText(t)}
			}
			switch {
			case nach != nil && vor != nil:
				return aufruf("time_window", nil, zeit(nach), zeit(vor))
			case nach != nil:
				return vergleiche(">=", &ir{art: 'k'}, zeit(nach))
			case vor != nil:
				return vergleiche("<", &ir{art: 'k'}, zeit(vor))
			}
			a.stopp("eine Zeit-Bedingung ohne after und before")
			return nil
		})
	}
	return nil, &Stelle{Ort: o, Grund: fmt.Sprintf("die Bedingung „%s“ lässt sich nicht übersetzen", art)}
}

func (u *uebersetzer) numerisch(a *auswerter, datei string, n *yaml.Node, env umgebung) *ir {
	var alle []*ir
	for _, id := range entities(feld(n, "entity_id")) {
		var v *ir
		if attr := text(feld(n, "attribute")); attr != "" {
			if id != "sun.sun" || attr != "elevation" {
				a.stopp("das Attribut %s von %s lässt sich nicht übersetzen", attr, id)
			}
			v = u.ref(u.sonne())
		} else {
			v, _ = u.zahlVon(a, id)
		}
		var teile []*ir
		if x := feld(n, "above"); x != nil {
			teile = append(teile, vergleiche(">", v, u.wertOderEntity(a, datei, x, env)))
		}
		if x := feld(n, "below"); x != nil {
			teile = append(teile, vergleiche("<", v, u.wertOderEntity(a, datei, x, env)))
		}
		if len(teile) == 0 {
			a.stopp("numeric_state ohne above und below")
		}
		alle = append(alle, und(teile...))
	}
	if len(alle) == 0 {
		a.stopp("numeric_state ohne entity_id")
	}
	return und(alle...)
}

// liesAusloeser übersetzt einen Auslöser.
func (u *uebersetzer) liesAusloeser(datei string, n *yaml.Node) (ausloeser, *Stelle) {
	o := Ort{Datei: datei, Zeile: n.Line}
	art := text(erstesFeld(n, "trigger", "platform"))
	al := ausloeser{ort: o, text: art}
	switch art {
	case "time_pattern":
		al.art = "raster"
		for _, f := range []struct {
			k string
			s float64
		}{{"seconds", 1}, {"minutes", 60}, {"hours", 3600}} {
			t := text(feld(n, f.k))
			if strings.HasPrefix(t, "/") {
				if k, err := strconv.ParseFloat(t[1:], 64); err == nil && al.raster == 0 {
					al.raster = k * f.s
				}
			}
		}
		return al, nil
	case "homeassistant":
		if text(feld(n, "event")) == "start" {
			al.art = "start"
			return al, nil
		}
		return al, &Stelle{Ort: o, Grund: "nur der Auslöser beim Start von Home Assistant lässt sich übersetzen"}
	case "state", "numeric_state":
		var bed *ir
		var f *Stelle
		if art == "state" {
			if feld(n, "attribute") != nil {
				return al, &Stelle{Ort: o, Grund: "ein Auslöser auf ein Attribut lässt sich nicht übersetzen"}
			}
			nach := feld(n, "to")
			if nach == nil || (nach.Kind == yaml.ScalarNode && nach.Tag == "!!null") {
				al.art = "weck" // jede Änderung weckt
				return al, nil
			}
			bed, f = u.mitAuswerter(o, nil, func(a *auswerter) *ir {
				var alle []*ir
				for _, id := range entities(feld(n, "entity_id")) {
					var eines []*ir
					for _, z := range liste(nach) {
						eines = append(eines, u.zustandIst(a, id, text(z)))
					}
					alle = append(alle, oder(eines...))
				}
				return oder(alle...)
			})
		} else {
			bed, f = u.mitAuswerter(o, nil, func(a *auswerter) *ir { return u.numerisch(a, datei, n, nil) })
		}
		if f != nil {
			return al, f
		}
		al.art, al.ebene = "ebene", bed
		if d := feld(n, "for"); d != nil {
			s, ok := dauerSekunden(d)
			if !ok {
				return al, &Stelle{Ort: o, Grund: "die Dauer von „for“ lässt sich nicht lesen"}
			}
			al.halte, al.dauer = bed, s
		}
		return al, nil
	case "template":
		bed, f := u.vorlageBedingung(datei, erstesFeld(n, "value_template"), nil)
		if f != nil {
			return al, f
		}
		al.art, al.ebene = "ebene", bed
		return al, nil
	case "time":
		bed, f := u.mitAuswerter(o, nil, func(a *auswerter) *ir {
			var eines []*ir
			for _, x := range liste(feld(n, "at")) {
				t := text(x)
				if strings.Contains(t, ".") {
					eines = append(eines, vergleiche("==", &ir{art: 'k'}, u.uhrzeitVon(a, t)))
				} else {
					eines = append(eines, vergleiche("==", &ir{art: 'k'}, &ir{art: 'u', text: uhrText(t)}))
				}
			}
			return oder(eines...)
		})
		if f != nil {
			return al, f
		}
		al.art, al.ebene = "ebene", bed
		return al, nil
	}
	return al, &Stelle{Ort: o, Grund: fmt.Sprintf("der Auslöser „%s“ lässt sich nicht übersetzen", art)}
}

// wirksam nennt, was gelten muss, damit die Automation etwas tut, als Liste von Bedingungen.
func (u *uebersetzer) wirksam(au *automation) (items []*ir, raster float64, nurStart bool, weggefallen bool, ok bool) {
	datei := au.ort.Datei
	ok = true
	for _, n := range au.bedingung {
		e, f := u.bedingung(datei, n, nil)
		if f != nil {
			u.nichtUebersetzbar(f.Ort, au.alias, f.Grund)
			ok = false
			continue
		}
		if e.art == 'a' {
			items = append(items, e.kinder...)
		} else {
			items = append(items, e)
		}
	}
	var al []ausloeser
	for _, n := range au.ausloeser {
		a, f := u.liesAusloeser(datei, n)
		if f != nil {
			u.nichtUebersetzbar(f.Ort, au.alias, f.Grund)
			ok = false
			continue
		}
		al = append(al, a)
	}
	if !ok {
		return nil, 0, false, false, false
	}
	nurStart = len(al) > 0
	raster = -1
	for _, a := range al {
		if a.art != "start" {
			nurStart = false
		}
		switch {
		case a.art == "raster" && (raster == -1 || raster == a.raster):
			raster = a.raster
		case a.art != "start":
			raster = 0
		}
	}
	if raster < 0 {
		raster = 0
	}
	if nurStart {
		return items, 0, true, false, true
	}
	andere := 0
	for _, a := range al {
		if a.art != "start" {
			andere++
		}
	}
	var ebenen []*ir
	immer := false
	for _, a := range al {
		switch a.art {
		case "start":
			continue
		case "raster":
			immer = true
			continue
		case "weck":
			immer = true
			weggefallen = true
			continue
		}
		if a.halte != nil {
			gefunden := false
			for i, x := range items {
				if x.String() == a.halte.String() {
					items[i] = aufruf("holds", nil, x, zahl(a.dauer, neueGroesse(gDauer, "s")))
					gefunden = true
				}
			}
			if gefunden {
				immer = true
				weggefallen = true
				continue
			}
			if andere == 1 {
				items = append(items, aufruf("holds", nil, a.halte, zahl(a.dauer, neueGroesse(gDauer, "s"))))
				immer = true
				weggefallen = true
				continue
			}
			u.hinweis(a.ort, "", "Diesen Auslöser („seit "+sekundenText(a.dauer)+"“) übernimmt die Logik nicht als Bedingung, weil die Automation auch durch andere Auslöser läuft.")
			weggefallen = true
			continue
		}
		ebenen = append(ebenen, a.ebene)
		weggefallen = true
	}
	if !immer && len(ebenen) > 0 {
		items = append(items, oder(ebenen...))
	}
	items = und(items...).liste()
	return items, raster, false, weggefallen, true
}

func (au *automation) titel() string {
	if au.alias != "" {
		return au.alias
	}
	return au.id
}

// liste zerlegt eine Und-Verknüpfung in ihre Teile.
func (e *ir) liste() []*ir {
	switch {
	case e == nil || e.istWahr(true):
		return nil
	case e.art == 'a':
		return e.kinder
	}
	return []*ir{e}
}

// aktionen übersetzt eine Folge von Aktionen in ihre Wirkungen.
func (u *uebersetzer) aktionen(datei string, ns []*yaml.Node, env umgebung, bed *ir, tiefe int) ([]wirkung, bool) {
	var out []wirkung
	ok := true
	if env == nil {
		env = umgebung{}
	}
	for _, n := range ns {
		o := Ort{Datei: datei, Zeile: n.Line}
		if n.Kind != yaml.MappingNode {
			u.nichtUebersetzbar(o, "Aktion", "unbekannte Form einer Aktion")
			ok = false
			continue
		}
		switch {
		case feld(n, "variables") != nil:
			v := feld(n, "variables")
			for i := 0; i+1 < len(v.Content); i += 2 {
				w, f := u.vorlageWert(datei, v.Content[i+1], env)
				if f != nil {
					u.nichtUebersetzbar(f.Ort, "variables: "+v.Content[i].Value, f.Grund)
					ok = false
					continue
				}
				env[v.Content[i].Value] = w
			}
		case feld(n, "if") != nil:
			var teile []*ir
			for _, c := range liste(feld(n, "if")) {
				e, f := u.bedingung(datei, c, env)
				if f != nil {
					u.nichtUebersetzbar(f.Ort, "if", f.Grund)
					ok = false
					continue
				}
				teile = append(teile, e)
			}
			c := und(teile...)
			w1, ok1 := u.aktionen(datei, liste(feld(n, "then")), env, und(bed, c), tiefe)
			w2, ok2 := u.aktionen(datei, liste(feld(n, "else")), env, und(bed, nicht(c)), tiefe)
			out = append(append(out, w1...), w2...)
			ok = ok && ok1 && ok2
		case feld(n, "choose") != nil:
			var vorher []*ir
			for _, zweig := range liste(feld(n, "choose")) {
				var teile []*ir
				for _, c := range liste(feld(zweig, "conditions")) {
					e, f := u.bedingung(datei, c, env)
					if f != nil {
						u.nichtUebersetzbar(f.Ort, "choose", f.Grund)
						ok = false
						continue
					}
					teile = append(teile, e)
				}
				c := und(teile...)
				w, ok1 := u.aktionen(datei, liste(feld(zweig, "sequence")), env, und(append([]*ir{bed}, append(vorher, c)...)...), tiefe)
				out = append(out, w...)
				ok = ok && ok1
				vorher = append(vorher, nicht(c))
			}
			w, ok1 := u.aktionen(datei, liste(feld(n, "default")), env, und(append([]*ir{bed}, vorher...)...), tiefe)
			out = append(out, w...)
			ok = ok && ok1
		case feld(n, "condition") != nil:
			e, f := u.bedingung(datei, n, env)
			if f != nil {
				u.nichtUebersetzbar(f.Ort, "condition", f.Grund)
				ok = false
				continue
			}
			bed = und(bed, e)
		case erstesFeld(n, "action", "service") != nil:
			w, ok1 := u.dienst(datei, n, env, bed, tiefe)
			out = append(out, w...)
			ok = ok && ok1
		default:
			was := "Aktion"
			for i := 0; i < len(n.Content); i += 2 {
				was = n.Content[i].Value
				break
			}
			grund := "diese Aktion lässt sich nicht übersetzen"
			switch was {
			case "delay", "wait_template", "wait_for_trigger", "repeat":
				grund = "Abläufe mit Warten gibt es in der Logik nicht; „Schalte ein, warte, schalte aus“ wird ein Zustand mit Zeitgeber"
			}
			u.nichtUebersetzbar(o, was, grund)
			ok = false
		}
	}
	return out, ok
}

// ziele nennt die Ziele einer Aktion, auch aus einer Vorlage ("{{ aus }}"), je mit Bedingung.
func (u *uebersetzer) ziele(datei string, n *yaml.Node, env umgebung) ([]element, *Stelle) {
	var out []element
	for _, quelle := range []*yaml.Node{feld(feld(n, "target"), "entity_id"), feld(n, "entity_id"), feld(feld(n, "data"), "entity_id")} {
		for _, e := range liste(quelle) {
			t := text(e)
			if !IstVorlage(t) {
				for _, id := range entities(e) {
					out = append(out, element{bed: wahr(true), w: wert{art: 't', text: id}})
				}
				continue
			}
			w, f := u.vorlageWert(datei, e, env)
			if f != nil {
				return nil, f
			}
			switch w.art {
			case 't':
				out = append(out, element{bed: wahr(true), w: w})
			case 'l':
				for _, x := range w.el {
					if x.w.art != 't' {
						return nil, &Stelle{Ort: Ort{Datei: datei, Zeile: e.Line}, Grund: "die Ziele müssen Kennungen sein"}
					}
					out = append(out, x)
				}
			default:
				return nil, &Stelle{Ort: Ort{Datei: datei, Zeile: e.Line}, Grund: "die Ziele müssen Kennungen sein"}
			}
		}
	}
	return out, nil
}

func (u *uebersetzer) dienst(datei string, n *yaml.Node, env umgebung, bed *ir, tiefe int) ([]wirkung, bool) {
	o := Ort{Datei: datei, Zeile: n.Line}
	d := text(erstesFeld(n, "action", "service"))
	bereich, tat, _ := strings.Cut(d, ".")
	// Ein Skript aufrufen: seine Aktionen gelten mit der Bedingung des Aufrufs.
	if bereich == "script" {
		id := tat
		if tat == "turn_on" {
			ids := zieleWoertlich(n)
			if len(ids) != 1 {
				u.nichtUebersetzbar(o, d, "script.turn_on mit mehr als einem Skript lässt sich nicht übersetzen")
				return nil, false
			}
			id = strings.TrimPrefix(ids[0], "script.")
		}
		for _, s := range u.ha.skripte {
			if s.id == id {
				if tiefe > 4 {
					u.nichtUebersetzbar(o, d, "Skripte rufen sich zu tief auf")
					return nil, false
				}
				return u.aktionen(s.ort.Datei, s.sequenz, umgebung{}, bed, tiefe+1)
			}
		}
		u.nichtUebersetzbar(o, d, "das Skript steht in keiner Datei")
		return nil, false
	}
	ziele, f := u.ziele(datei, n, env)
	if f != nil {
		u.nichtUebersetzbar(f.Ort, d, f.Grund)
		return nil, false
	}
	daten := feld(n, "data")
	var out []wirkung
	ok := true
	for _, z := range ziele {
		id := z.w.text
		b := und(bed, z.bed)
		s := u.symbole[id]
		zb, _, _ := strings.Cut(id, ".")
		if s == nil && (zb == "switch" || zb == "light") {
			g, i := u.geraetVon(id)
			s = &symbol{art: 'A', entity: id, geraet: g, index: i}
			u.symbole[id] = s
		}
		if s == nil {
			u.nichtUebersetzbar(o, d, "„"+id+"“ steht in keiner Datei")
			ok = false
			continue
		}
		w := wirkung{symbol: s, bed: b, ort: o}
		switch {
		case s.art == 'B' && (tat == "turn_on" || tat == "turn_off"):
			w.art = map[string]string{"turn_on": "bool_an", "turn_off": "bool_aus"}[tat]
		case s.art == 'C' && (tat == "increment" || tat == "decrement"):
			w.art, w.um = "um", 1
			if s.helfer != nil && s.helfer.schritt != nil {
				w.um = int(*s.helfer.schritt)
				if float64(w.um) != *s.helfer.schritt {
					u.nichtUebersetzbar(o, d, "ein Zähler zählt in ganzen Schritten; der Helfer hat step "+zahlOhneEinheit(*s.helfer.schritt))
					ok = false
					continue
				}
			}
			if tat == "decrement" {
				w.um = -w.um
			}
		case s.art == 'C' && (tat == "set_value" || tat == "reset"):
			w.art = "setze"
			if tat == "reset" {
				w.setze = zahl(0, neueGroesse(gZahl, ""))
				if s.helfer != nil && s.helfer.initial != nil {
					if v := zahlVon(s.helfer.initial); v != nil {
						w.setze = zahl(*v, neueGroesse(gZahl, ""))
					}
				}
			} else {
				v := feld(daten, "value")
				if v == nil {
					u.nichtUebersetzbar(o, d, "set_value ohne value")
					ok = false
					continue
				}
				e, f := u.mitAuswerter(o, env, func(a *auswerter) *ir { return u.wertOderEntity(a, datei, v, env) })
				if f != nil {
					u.nichtUebersetzbar(f.Ort, d, f.Grund)
					ok = false
					continue
				}
				w.setze = e
			}
		case s.art == 'T' && tat == "start":
			w.art = "timer_start"
			if dn := feld(daten, "duration"); dn != nil {
				if IstVorlage(text(dn)) {
					v, f := u.vorlageWert(datei, dn, env)
					if f != nil {
						u.nichtUebersetzbar(f.Ort, d, f.Grund)
						ok = false
						continue
					}
					e, f := u.mitAuswerter(o, env, func(a *auswerter) *ir { return a.zahlWert(v) })
					if f != nil {
						u.nichtUebersetzbar(f.Ort, d, f.Grund)
						ok = false
						continue
					}
					if g, _ := e.groesse().aufgeloest(); g == gZahl {
						e.q = neueGroesse(gDauer, "s")
						if e.art == 'z' {
							e = zahl(e.v, neueGroesse(gDauer, "s"))
						}
					}
					w.dauer = e
				} else if sek, ok2 := dauerSekunden(dn); ok2 {
					w.dauer = zahl(sek, neueGroesse(gDauer, "s"))
				}
			}
		case s.art == 'T' && (tat == "cancel" || tat == "finish"):
			w.art = "timer_stop"
		case s.art == 'A' && (tat == "turn_on" || tat == "turn_off"):
			w.art = map[string]string{"turn_on": "schalter_an", "turn_off": "schalter_aus"}[tat]
		default:
			u.nichtUebersetzbar(o, d+" "+id, "diese Aktion lässt sich nicht übersetzen")
			ok = false
			continue
		}
		out = append(out, w)
	}
	return out, ok
}

// deuteAutomationen macht aus jeder Automation Bedingungen von Zuständen und Schritte von Zählern.
func (u *uebersetzer) deuteAutomationen() {
	an := map[*zustand][]bedListe{}
	aus := map[*zustand][]bedListe{}
	zaehlerVon := map[*zustand][]*automation{}
	for _, au := range u.ha.automations {
		items, raster, nurStart, weggefallen, ok := u.wirksam(au)
		if !ok {
			continue
		}
		wirkungen, ok := u.aktionen(au.ort.Datei, au.aktionen, nil, wahr(true), 0)
		if !ok {
			continue
		}
		nurSchalter := len(wirkungen) > 0
		zaehlt := false
		for _, w := range wirkungen {
			if w.art != "schalter_an" && w.art != "schalter_aus" {
				nurSchalter = false
			}
			if w.art == "um" || w.art == "setze" {
				zaehlt = true
			}
		}
		if !weggefallen && raster > 0 && !zaehlt && !nurSchalter {
			u.hinweis(au.ort, "", "Home Assistant prüft „"+au.titel()+"“ nur "+abstandText(raster)+" (time_pattern); die Logik prüft ihre Bedingungen jede Sekunde und reagiert deshalb bis zu "+sekundenText(raster)+" früher.")
		}
		if weggefallen || (nurSchalter && raster > 0) {
			if nurSchalter {
				wann := "bei Auslösern und Auffangläufen"
				if !weggefallen {
					wann = abstandText(raster)
				}
				u.hinweis(au.ort, "outputs", "Home Assistant setzt die Schalter nur, wenn „"+au.titel()+"“ läuft ("+wann+"); die Logik stellt die Ausgänge in jedem Takt. Sie schaltet deshalb früher, sobald sich die Bedingungen ändern, nicht erst beim nächsten Lauf.")
			} else {
				u.hinweis(au.ort, "", "Home Assistant prüft „"+au.titel()+"“ nur, wenn ein Auslöser sie weckt; die Logik prüft ihre Bedingungen in jedem Takt. Auffangläufe (time_pattern) entfallen, eine verpasste Flanke gibt es nicht.")
			}
		}
		if nurStart {
			u.nachNeustart(au, wirkungen)
			for _, w := range wirkungen {
				if w.symbol.zustand != nil {
					w.symbol.zustand.quellen = append(w.symbol.zustand.quellen, au.ort)
				}
			}
			continue
		}
		var schrittDieser *schritt
		var zStart []wirkung
		for _, w := range wirkungen {
			z := w.symbol.zustand
			eigene := append(append([]*ir{}, items...), w.bed.liste()...)
			switch w.art {
			case "bool_an":
				an[z] = append(an[z], bedListe{items: ohne(eigene, nicht(u.ref(w.symbol))), ort: au.ort})
				z.quellen = append(z.quellen, au.ort)
			case "bool_aus":
				aus[z] = append(aus[z], bedListe{items: ohne(eigene, u.ref(w.symbol)), ort: au.ort})
				z.quellen = append(z.quellen, au.ort)
			case "um", "setze":
				if schrittDieser != nil {
					u.nichtUebersetzbar(w.ort, au.titel(), "eine Automation ändert einen Zähler zweimal")
					continue
				}
				s := &schritt{name: au.id, um: w.um, setze: w.setze, ort: au.ort, sinkt: w.um < 0}
				if s.name == "" {
					s.name = au.alias
				}
				u.zaehlerSchritt(z, s, eigene, raster, au)
				schrittDieser = s
				z.schritte = append(z.schritte, s)
				zaehlerVon[z] = append(zaehlerVon[z], au)
			case "timer_start":
				zStart = append(zStart, w)
			case "timer_stop":
				u.nichtUebersetzbar(w.ort, au.titel(), "einen Zeitgeber anhalten kann eine Logik nicht; er läuft seine Dauer ab")
			case "schalter_an", "schalter_aus":
				g := w.symbol.geraet
				g.geschrieben = true
				b := und(eigene...)
				u.wurzeln = append(u.wurzeln, &b)
				u.wurzelOrt = append(u.wurzelOrt, w.ort)
				if w.art == "schalter_an" {
					g.an[w.symbol.index] = append(g.an[w.symbol.index], b)
				} else {
					g.aus[w.symbol.index] = append(g.aus[w.symbol.index], b)
				}
				if g.ort.Datei == "" {
					g.ort = w.ort
				}
				g.quellen = append(g.quellen, au.ort)
			}
		}
		for _, w := range zStart {
			z := w.symbol.zustand
			if schrittDieser == nil {
				u.nichtUebersetzbar(w.ort, au.titel(), "ein Zeitgeber startet in der Logik nur mit einem Schritt eines Zählers (then: start(…)); diese Automation ändert keinen Zähler")
				continue
			}
			if schrittDieser.startet != "" {
				u.nichtUebersetzbar(w.ort, au.titel(), "ein Schritt startet höchstens einen Zeitgeber")
				continue
			}
			schrittDieser.startet = z.kennung
			if !w.bed.istWahr(true) {
				schrittDieser.startWenn = w.bed
				u.wurzeln = append(u.wurzeln, &schrittDieser.startWenn)
				u.wurzelOrt = append(u.wurzelOrt, w.ort)
			}
			u.zeitgeberDauer(z, w)
		}
	}
	for _, z := range u.zustaende {
		if z.art == "boolean" && z.sym.vorlage == nil {
			u.schalterAus(z, an[z], aus[z])
		}
		if z.art == "counter" {
			u.zaehlerFertig(z, zaehlerVon[z])
		}
		if z.art == "timer" {
			if z.dauer == nil && z.sym.helfer.dauer != nil {
				z.dauer = zahl(*z.sym.helfer.dauer, neueGroesse(gDauer, "s"))
			}
			if z.dauer == nil {
				z.dauer = zahl(0, neueGroesse(gDauer, "s"))
				u.nichtUebersetzbar(z.ort, z.name, "der Zeitgeber hat keine Dauer")
			}
			if z.nachNeustart == "" {
				if z.sym.helfer.restore {
					z.nachNeustart = "keep"
				} else {
					z.nachNeustart = "off"
				}
			}
		}
	}
}

func ohne(items []*ir, weg *ir) []*ir {
	var out []*ir
	for _, x := range items {
		if x.String() != weg.String() {
			out = append(out, x)
		}
	}
	return out
}

// bedListe sind die Bedingungen einer Automation, die einen Zustand ändert.
type bedListe struct {
	items []*ir
	ort   Ort
}
