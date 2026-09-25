package com.voltpilot.api.uems;

import com.voltpilot.api.web.dto.BezugsbasisDto;
import com.voltpilot.api.web.dto.EnergiemanagementVerantwortungDto.Freigabe;
import com.voltpilot.api.web.dto.EnergiemanagementVerantwortungDto.Objekt;
import com.voltpilot.api.web.dto.EnergiemanagementVerantwortungDto.Person;
import com.voltpilot.api.web.dto.EnergiezielDto;
import com.voltpilot.api.web.dto.KennzahlDto;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * UEMS AP-19 IP-10 (PA4): die Verantwortlichen der Objekte von AP-11 bis AP-18 — gelesen über deren Register-Leser,
 * also mit ihrem Zaun und ihren Rechten; was der Aufrufer dort nicht sieht, steht hier nicht.
 *
 * <p>Kennzahl, Energieeinsatz und Bezugsbasis zählen, solange sie laufen (nicht archiviert, nicht beendet); Energieziel,
 * Maßnahme und Abweichung in jedem Zustand, der am Objekt steht. Die Bezugsbasis trägt den Verantwortlichen, den AP-17
 * B4 von der Kennzahl vorgibt — ob er freigibt, sagt {@link #bezugsbasenFreigaben()}.
 */
@Component
@Order(0)
public class VerantwortungBestand implements VerantwortungQuelle {

    /** Die Arten dieser Quelle in ihrer Reihenfolge — {@code objekt.art} in {@code openapi.yaml}. */
    static final List<String> ARTEN = List.of("kennzahl", "energieeinsatz", "bezugsbasis", "energieziel", "massnahme",
            "abweichung");

    private final KennzahlService kennzahlen;
    private final EnergieeinsatzService einsaetze;
    private final BezugsbasisService bezugsbasen;
    private final EnergiezielService energieziele;
    private final MassnahmeService massnahmen;
    private final AbweichungService abweichungen;

    public VerantwortungBestand(KennzahlService kennzahlen, EnergieeinsatzService einsaetze,
            BezugsbasisService bezugsbasen, EnergiezielService energieziele, MassnahmeService massnahmen,
            AbweichungService abweichungen) {
        this.kennzahlen = kennzahlen;
        this.einsaetze = einsaetze;
        this.bezugsbasen = bezugsbasen;
        this.energieziele = energieziele;
        this.massnahmen = massnahmen;
        this.abweichungen = abweichungen;
    }

    @Override
    public List<Objekt> objekte() {
        var aus = new ArrayList<Objekt>();
        List<KennzahlDto.Kennzahl> laufend = laufendeKennzahlen();
        for (var k : laufend) {
            aus.add(new Objekt("kennzahl", k.id(), k.kennzeichen(), k.name(), nurName(k.verantwortlichName()), null));
        }
        for (var e : einsaetze.liste(null).energieeinsaetze()) {
            if (e.gueltigBis() != null) continue;
            var v = e.verantwortlich();
            aus.add(new Objekt("energieeinsatz", e.id(), e.kennzeichen(), e.name(),
                    v == null ? null : new Person(v.sub(), v.name()), null));
        }
        var basen = new ArrayList<Objekt>();
        for (var k : laufend) {
            for (var b : bezugsbasen.liste(k.id()).bezugsbasen()) {
                if (b.beendetZum() != null) continue;
                basen.add(new Objekt("bezugsbasis", b.id(), b.kennzeichen(), titel(k), nurName(b.verantwortlichName()),
                        null));
            }
        }
        basen.sort(Comparator.comparing(Objekt::kennzeichen));
        aus.addAll(basen);
        for (var z : energieziele.liste(List.of(), null, null).energieziele()) {
            aus.add(new Objekt("energieziel", z.id(), z.kennzeichen(), z.wortlaut(), person(z.verantwortlich()),
                    z.zustand()));
        }
        for (var m : massnahmen.liste(List.of(), null, null, null, null).massnahmen()) {
            var v = m.verantwortlich();
            aus.add(new Objekt("massnahme", m.id(), m.kennzeichen(), m.titel(),
                    v == null ? null : new Person(v.sub(), v.name()), m.zustand()));
        }
        for (var a : abweichungen.liste(List.of(), null, null, null).abweichungen()) {
            var v = a.verantwortlich();
            aus.add(new Objekt("abweichung", a.id(), a.kennzeichen(),
                    a.kennzahl().kennzeichen() + " " + a.kennzahl().name(),
                    v == null ? null : new Person(v.sub(), v.name()), a.zustand()));
        }
        return aus;
    }

    /**
     * Jede freigegebene Fassung jeder Bezugsbasis der sichtbaren Kennzahlen — auch abgelöste Fassungen und beendete
     * Basen, denn die Freigabe bleibt eine Entscheidung dieser Person. Nach Basis, dann Fassung.
     */
    public List<Freigabe> bezugsbasenFreigaben() {
        var aus = new ArrayList<Freigabe>();
        for (var k : kennzahlen.liste().kennzahlen()) {
            for (var b : bezugsbasen.liste(k.id()).bezugsbasen()) {
                for (var f : b.fassungen()) {
                    if (!"freigegeben".equals(f.freigabeStatus())) continue;
                    BezugsbasisDto.Fassung voll = bezugsbasen.fassung(k.id(), b.id(), f.fassung());
                    aus.add(new Freigabe(b.id(), b.kennzeichen(), k.id(), k.kennzeichen(), f.fassung(),
                            name(voll.freigabe()), voll.freigegebenAm(), voll.vieraugen(),
                            voll.vieraugen() ? name(voll.entscheidung()) : null));
                }
            }
        }
        aus.sort(Comparator.comparing(Freigabe::bezugsbasis).thenComparingInt(Freigabe::fassung));
        return aus;
    }

    private List<KennzahlDto.Kennzahl> laufendeKennzahlen() {
        return kennzahlen.liste().kennzahlen().stream().filter(k -> k.archiviertAm() == null).toList();
    }

    private static String titel(KennzahlDto.Kennzahl k) {
        return k.kennzeichen() + " " + k.name();
    }

    private static Person nurName(String name) {
        return name == null || name.isBlank() ? null : new Person(null, name);
    }

    private static Person person(EnergiezielDto.Person p) {
        return p == null ? null : new Person(p.sub(), p.name());
    }

    private static String name(BezugsbasisDto.Person p) {
        return p == null ? null : p.name();
    }
}
