package com.voltpilot.api.uems;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;

/**
 * Die Herkunft GESPEICHERTER berechneter Werte für die Routen (UEMS AP-10 IP-12, E13): liest, was
 * {@link BerechnetePeriodenLauf} und die Korrektur-Kaskade zu einer Zeile abgelegt haben — Formel-Fassung,
 * {@code bilanzwert_eingang} in der Version des Werts, den Anlass —, und baut daraus über
 * {@link BilanzwertHerkunft#ausGespeichert} den Satz. Es rechnet nichts nach.
 *
 * <p>Die Zahl selbst (Menge, Zustand, Abdeckung, Kennzeichen, Version) reicht die Route herein: der Satz beschreibt
 * genau die Zahl, die daneben steht, und kann darum nicht von ihr abweichen. Es gibt EINEN je
 * {@link MessstelleWerteService}; Bilanz und Kostenstelle erreichen ihn über dessen {@code herkunft()}.
 */
public class BilanzwertHerkunftLeser {

    /** Die Zahl, deren Herkunft gesucht ist; {@code null} = diese Zeile zeigt die Route nicht. */
    public record Wert(int version, BilanzwertHerkunft.Ergebnis ergebnis) {}

    private final BerechnetePeriodenRepository speicher;

    public BilanzwertHerkunftLeser(BerechnetePeriodenRepository speicher) {
        this.speicher = speicher;
    }

    /**
     * Die Hüllen {@code {satz, fehlt}} der gespeicherten Zeilen einer berechneten Messstelle mit Beginn in
     * {@code [von, bis)}, je Beginn. {@code wertZu} nennt zu einer gespeicherten Zeile die Zahl der Route (oder
     * {@code null}); {@code zone} gilt für die Viertelstunde, Tag/Monat/Jahr tragen ihre gespeicherte Zone.
     */
    public Map<Instant, Map<String, Object>> umschlaege(UUID messstelleId, String kennzeichen, String ebene,
            Instant von, Instant bis, ZoneId zone, Function<BerechnetePeriodenRepository.HerkunftFakten, Wert> wertZu) {
        Map<Instant, BerechnetePeriodenRepository.HerkunftFakten> fakten =
                speicher.herkunftFakten(messstelleId, ebene, von, bis);
        Map<Instant, Map<String, Object>> raus = new HashMap<>();
        if (fakten.isEmpty()) {
            return raus;
        }
        List<BilanzwertHerkunft.VerteilungZeile> verteilungen = speicher.verteilungen(messstelleId,
                LocalDate.ofInstant(von, zone).minusDays(1), LocalDate.ofInstant(bis, zone).plusDays(1));
        for (BerechnetePeriodenRepository.HerkunftFakten f : fakten.values()) {
            Wert w = wertZu.apply(f);
            if (w == null) {
                continue;
            }
            BilanzwertHerkunft.Urteil u = BilanzwertHerkunft.ausGespeichert(new BilanzwertHerkunft.Gespeichert(
                    kennzeichen, ebene, f.beginn(), f.zone() == null ? zone : f.zone(), f.formelTyp(),
                    f.fassungNummer(), f.berechnetAm().get(w.version()), w.version(), f.anlass().get(w.version()),
                    verteilungen, f.eingaenge().getOrDefault(w.version(), List.of()), w.ergebnis()));
            raus.put(f.beginn(), BilanzwertHerkunft.umschlag(u));
        }
        return raus;
    }

    /**
     * Die Hülle eines BEIM LESEN gerechneten Werts (der Rest der Bilanz je Anlage, AP-10 IP-9): dieselben Regeln wie
     * gespeichert, der Rechenzeitpunkt ist der der Antwort, die Version die höchste der Eingänge. Ohne Messstelle
     * ({@code messstelleId} null — kein bestätigter Rest) nennt der Satz {@code messstelle} und
     * {@code formel_fassung} als fehlend: wessen Zahl das ist, lässt sich dann nicht sagen.
     */
    public Map<String, Object> umschlagGelesen(UUID messstelleId, String kennzeichen, UUID fassungId,
            String formelTyp, String periodeArt, LocalDate von, LocalDate bis, ZoneId zone, Instant berechnetAm,
            List<BilanzwertHerkunft.GespeicherterEingang> eingaenge, BilanzwertHerkunft.Ergebnis ergebnis) {
        int version = eingaenge.stream().mapToInt(e -> e.version() == null ? 1 : e.version()).max().orElse(1);
        return BilanzwertHerkunft.umschlag(BilanzwertHerkunft.ausGespeichert(new BilanzwertHerkunft.Gespeichert(
                kennzeichen, periodeArt, von.atStartOfDay(zone).toInstant(), zone, formelTyp,
                fassungId == null ? null : speicher.fassungNummer(fassungId), berechnetAm, version, null,
                messstelleId == null ? List.of() : speicher.verteilungen(messstelleId, von, bis), eingaenge, ergebnis)));
    }
}
