package com.voltpilot.api.uems;

import com.voltpilot.api.uems.MessstelleFormelTermRepository.TermZeile;
import com.voltpilot.api.uems.MessstelleRegisterRepository.Bestand;
import com.voltpilot.api.uems.MessstelleRegisterRepository.Messwert;
import com.voltpilot.api.uems.MessstelleRegisterRepository.Werte;
import com.voltpilot.api.uems.MessstelleRepository.Messstelle;
import com.voltpilot.api.web.dto.MessstelleDto;
import com.voltpilot.api.zugriff.RechtPruefung;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;
import java.util.function.Predicate;
import java.util.function.ToLongFunction;

/**
 * Die Vollständigkeit BERECHNETER Messstellen im Register (AP-10 IP-9): „Vollständig“ nur, wenn ALLE
 * Eingänge der Formel DES TAGES liefern ({@link ZustandAbleitung#berechnet}), sonst „Unvollständig seit …
 * (fehlt: MS-12)“. Die Eingänge sind die Terme der Fassung am Tag — bei einem Rest die Terme aus der
 * STELLUNG ({@link BilanzAbleitung#restAusStellung}, E3), nie gespeichert. Ein Eingang, der selbst eine
 * Messstelle ist, liefert, wenn seine Zeile es sagt (gemessen: Beobachtung, berechnet: vollständig); ein
 * Messkanal-Term aus seinem letzten guten Wert und seiner Kadenz ({@link ZustandAbleitung#liefertDaten}).
 *
 * <p>Nichts wird hier entschieden, was der Zustands-Vertrag nicht sagt: die Klasse sammelt nur Eingänge.
 * Ohne Formel am Tag (Entwurf, Rest ohne Hauptzähler) gibt es KEINE Berechnung ({@code null}) — das
 * Aggregat zählt sie dann wie eine gemessene Messstelle ohne Quelle.
 */
final class RegisterBerechnung {

    /** Ein Eingang: eine Messstelle ({@code messstelle}) ODER ein Messkanal ({@code kanal}). */
    record Eingang(String kennzeichen, UUID messstelle, Messwert kanal) {}

    /** Die Eingänge je berechneter Messstelle am Tag; fehlt ein Schlüssel, hat sie an dem Tag keine Formel. */
    record Plan(Map<UUID, List<Eingang>> eingaenge) {

        static final Plan LEER = new Plan(Map.of());

        Set<Messwert> kanaele() {
            Set<Messwert> out = new LinkedHashSet<>();
            eingaenge.values().forEach(l -> l.stream().filter(e -> e.kanal() != null).forEach(e -> out.add(e.kanal())));
            return out;
        }
    }

    /** Ein Messkanal-Term hat keine Bindung und darum keinen Beginn: seine Werte zählen von Anfang an. */
    static final Instant KANAL_SEIT_BEGINN = Instant.EPOCH;

    private RegisterBerechnung() {}

    /**
     * Die Eingänge aller berechneten Messstellen des Bestands am Tag — zwei Abfragen (Fassungen, Terme),
     * und NUR, wenn es berechnete gibt: das Register ohne sie bleibt Abfrage für Abfrage, wie es war.
     */
    static Plan planen(List<Bestand> bestand, LocalDate tag, BilanzRestRepository reste,
            MessstelleFormelTermRepository terme) {
        List<UUID> berechnete = bestand.stream().map(Bestand::messstelle)
                .filter(m -> MessstelleRegeln.BERECHNET.equals(m.art())).map(Messstelle::id).toList();
        if (berechnete.isEmpty()) {
            return Plan.LEER;
        }
        Map<UUID, List<BilanzRestRepository.FassungMitRest>> jeMessstelle = new LinkedHashMap<>();
        for (BilanzRestRepository.FassungMitRest f : reste.fassungen(berechnete)) {
            jeMessstelle.computeIfAbsent(f.messstelleId(), k -> new ArrayList<>()).add(f);
        }
        Map<UUID, BilanzRestRepository.FassungMitRest> amTag = new LinkedHashMap<>();
        jeMessstelle.forEach((id, fassungen) -> MessstelleFormelRegeln
                .fassungAm(fassungen.stream().map(BilanzRestRepository.FassungMitRest::alsRegel).toList(), tag)
                .flatMap(r -> fassungen.stream().filter(f -> f.nummer() == r.nummer()).findFirst())
                .ifPresent(f -> amTag.put(id, f)));
        Map<UUID, List<TermZeile>> termeJeFassung = terme.derFassungen(amTag.values().stream()
                .filter(f -> f.restHauptzaehlerId() == null).map(BilanzRestRepository.FassungMitRest::id).toList());

        Map<UUID, Messstelle> nachId = new LinkedHashMap<>();
        List<MessstelleZuordnungRepository.StellungZeile> stellungen = new ArrayList<>();
        for (Bestand b : bestand) {
            nachId.put(b.messstelle().id(), b.messstelle());
            stellungen.addAll(b.stellungen());
        }
        List<BilanzAbleitung.StellungZeile> zeilen = BilanzStellungen.zeilen(nachId, MessstelleService.wirksam(stellungen));
        Map<String, Messstelle> nachKennzeichen = new LinkedHashMap<>();
        nachId.values().forEach(m -> nachKennzeichen.put(m.kennzeichen(), m));

        Map<UUID, List<Eingang>> out = new LinkedHashMap<>();
        amTag.forEach((id, f) -> {
            List<Eingang> eingaenge = new ArrayList<>();
            if (f.restHauptzaehlerId() != null) {
                Messstelle x = nachId.get(f.restHauptzaehlerId());
                BilanzAbleitung.RestFassung rest = x == null ? null
                        : BilanzAbleitung.restAusStellung(x.kennzeichen(), tag, zeilen);
                if (rest == null || rest.fehler() != null) {
                    return; // an diesem Tag kein Rest — keine Berechnung
                }
                LinkedHashSet<String> gesehen = new LinkedHashSet<>();
                for (BilanzAbleitung.RestTerm t : rest.terme()) {
                    Messstelle q = nachKennzeichen.get(t.messstelle());
                    if (gesehen.add(t.messstelle())) {
                        eingaenge.add(new Eingang(t.messstelle(), q == null ? null : q.id(), null));
                    }
                }
            } else {
                List<TermZeile> ts = termeJeFassung.getOrDefault(f.id(), List.of());
                if (ts.isEmpty()) {
                    return; // keine Formel
                }
                for (TermZeile t : ts) {
                    if (t.quellMessstelleId() != null) {
                        Messstelle q = nachId.get(t.quellMessstelleId());
                        eingaenge.add(new Eingang(q == null ? t.quellMessstelleId().toString() : q.kennzeichen(),
                                t.quellMessstelleId(), null));
                    } else {
                        eingaenge.add(new Eingang(t.pointKey(), null,
                                new Messwert(t.entityId(), t.pointKey(), KANAL_SEIT_BEGINN)));
                    }
                }
            }
            out.put(id, List.copyOf(eingaenge));
        });
        return new Plan(out);
    }

    /**
     * Die Berechnung je berechneter Zeile. {@code zeilen} sind ALLE Zeilen des Bestands (vor jedem Filter):
     * ein Eingang zählt, auch wenn seine Zeile nicht gezeigt wird.
     */
    static Map<UUID, MessstelleDto.RegisterBerechnung> ableiten(Plan plan, Map<UUID, MessstelleDto.RegisterZeile> zeilen,
            Map<Messwert, Werte> werte, ToLongFunction<Messwert> kadenzS, Instant zeitpunkt,
            Function<UUID, ZoneId> zone) {
        return ableiten(plan, zeilen, werte, kadenzS, zeitpunkt, zone, id -> true);
    }

    /**
     * Wie oben, gesehen von einem Leser, der nur die Messstellen sieht, die {@code lesbar} zulässt (AP-03 R-A3/R-A6/R-A7).
     * Liegt ein Eingang — auch über eine berechnete Messstelle hinweg — außerhalb, nennt die Berechnung ihn nicht:
     * sie urteilt allein über die sichtbaren Eingänge. Fehlt einer von ihnen, ist sie {@code unvollstaendig} mit
     * genau diesen (das gilt ohne jeden fremden Eingang); liefern alle sichtbaren, ist das Urteil nicht zu fällen
     * ({@link #AUSSERHALB_ZUGRIFF}, ohne {@code fehlend} und {@code seit}) — nie „vollständig“, nie ein Zustand des
     * fremden Eingangs. Der Satz {@link RechtPruefung#AUSSERHALB_ZUGRIFF} steht in {@code text}, ohne Namen und Anzahl.
     */
    static Map<UUID, MessstelleDto.RegisterBerechnung> ableiten(Plan plan, Map<UUID, MessstelleDto.RegisterZeile> zeilen,
            Map<Messwert, Werte> werte, ToLongFunction<Messwert> kadenzS, Instant zeitpunkt,
            Function<UUID, ZoneId> zone, Predicate<UUID> lesbar) {
        Map<UUID, ZustandAbleitung.BerechnetErgebnis> fertig = new LinkedHashMap<>();
        Set<UUID> fremd = new HashSet<>();
        for (UUID id : plan.eingaenge().keySet()) {
            ergebnis(id, plan, zeilen, werte, kadenzS, zeitpunkt, zone, fertig, new HashSet<>(), lesbar, fremd);
        }
        Map<UUID, MessstelleDto.RegisterBerechnung> out = new LinkedHashMap<>();
        fertig.forEach((id, e) -> {
            if (e == null) {
                return;
            }
            if (!fremd.contains(id)) {
                out.put(id, new MessstelleDto.RegisterBerechnung(e.vollstaendig() ? VOLLSTAENDIG : UNVOLLSTAENDIG,
                        e.fehlend(), e.seit() == null ? null : MessstelleService.zeit(e.seit()), e.text()));
            } else if (e.vollstaendig()) {
                out.put(id, new MessstelleDto.RegisterBerechnung(AUSSERHALB_ZUGRIFF, List.of(), null,
                        RechtPruefung.AUSSERHALB_ZUGRIFF));
            } else {
                out.put(id, new MessstelleDto.RegisterBerechnung(UNVOLLSTAENDIG, e.fehlend(),
                        e.seit() == null ? null : MessstelleService.zeit(e.seit()),
                        e.text() + " · " + RechtPruefung.AUSSERHALB_ZUGRIFF));
            }
        });
        return out;
    }

    static final String VOLLSTAENDIG = "vollstaendig";
    static final String UNVOLLSTAENDIG = "unvollstaendig";
    /** Ein Eingang liegt außerhalb des Zugriffs, und alle sichtbaren liefern: das Urteil ist nicht zu fällen. */
    static final String AUSSERHALB_ZUGRIFF = "ausserhalb_zugriff";

    private static ZustandAbleitung.BerechnetErgebnis ergebnis(UUID id, Plan plan,
            Map<UUID, MessstelleDto.RegisterZeile> zeilen, Map<Messwert, Werte> werte, ToLongFunction<Messwert> kadenzS,
            Instant zeitpunkt, Function<UUID, ZoneId> zone, Map<UUID, ZustandAbleitung.BerechnetErgebnis> fertig,
            Set<UUID> unterwegs, Predicate<UUID> lesbar, Set<UUID> fremd) {
        if (fertig.containsKey(id)) {
            return fertig.get(id);
        }
        List<Eingang> eingaenge = plan.eingaenge().get(id);
        if (eingaenge == null || !unterwegs.add(id)) {
            return null; // keine Formel am Tag, oder ein Kreis: kein „vollständig“ erfinden
        }
        ZoneId z = zone.apply(id);
        List<ZustandAbleitung.BerechnetEingang> urteile = new ArrayList<>();
        for (Eingang e : eingaenge) {
            if (e.messstelle() != null && !lesbar.test(e.messstelle())) {
                fremd.add(id); // außerhalb: kein Urteil, kein Kennzeichen, kein Zeitpunkt aus seinem Zustand
                continue;
            }
            ZustandAbleitung.LiefertDaten zustand = ZustandAbleitung.LiefertDaten.KEINE_DATENQUELLE;
            Instant seit = null;
            if (e.kanal() != null) {
                Werte w = werte.get(e.kanal());
                ZustandAbleitung.LiefertDatenErgebnis r = ZustandAbleitung.liefertDaten(
                        new ZustandAbleitung.LiefertDatenEingang(w != null, w == null ? null : w.letzterGuterWert(),
                                w != null && w.jeEinWert(), kadenzS.applyAsLong(e.kanal()), zeitpunkt, z));
                zustand = r.zustand();
                seit = r.seit();
            } else if (e.messstelle() != null) {
                MessstelleDto.RegisterZeile zeile = zeilen.get(e.messstelle());
                if (zeile != null && zeile.beobachtung() != null) {
                    zustand = ZustandAbleitung.LiefertDaten.vonCode(zeile.beobachtung().zustand());
                    seit = zeile.beobachtung().seit() == null ? null : zeile.beobachtung().seit().toInstant();
                } else if (plan.eingaenge().containsKey(e.messstelle())) {
                    ZustandAbleitung.BerechnetErgebnis sub = ergebnis(e.messstelle(), plan, zeilen, werte, kadenzS,
                            zeitpunkt, zone, fertig, unterwegs, lesbar, fremd);
                    if (sub != null && fremd.contains(e.messstelle())) {
                        fremd.add(id); // die Zahl des Eingangs umfasst selbst einen Eingang außerhalb
                        if (sub.vollstaendig()) {
                            continue; // sein Urteil ist nicht zu fällen — es zählt hier nicht als „liefert“
                        }
                    }
                    if (sub != null) {
                        zustand = sub.vollstaendig() ? ZustandAbleitung.LiefertDaten.LIEFERT
                                : ZustandAbleitung.LiefertDaten.LIEFERT_NICHT_SEIT;
                        seit = sub.seit();
                    }
                }
            }
            urteile.add(new ZustandAbleitung.BerechnetEingang(e.kennzeichen(), zustand, seit));
        }
        unterwegs.remove(id);
        ZustandAbleitung.BerechnetErgebnis r = urteile.isEmpty() && !fremd.contains(id) ? null
                : ZustandAbleitung.berechnet(urteile, zeitpunkt, z);
        fertig.put(id, r);
        return r;
    }
}
