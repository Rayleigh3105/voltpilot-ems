package com.voltpilot.api.uems;

import com.voltpilot.api.uems.VerbrauchRegeln.Ergebnis;
import com.voltpilot.api.uems.VerbrauchRegeln.Ersatzwert;
import com.voltpilot.api.uems.VerbrauchRegeln.Geltend;
import com.voltpilot.api.uems.VerbrauchRegeln.Geltende;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** E7/E9: Ersatzwerte in gröberen Perioden, ohne aus einer Periodenmenge ein Profil zu erfinden.
 * Die bereits gerechneten Teilmengen kommen aus IP-13; dieser Schritt ersetzt ihren Beitrag genau einmal.
 * Zwilling: frontend/portal/src/ersatzwertPerioden.ts; Vertrag: verbrauch-vectors.json/ersatzwert_perioden.
 */
public final class ErsatzwertPerioden {
    private ErsatzwertPerioden() {}

    public record Beitrag(Instant von, Instant bis, BigDecimal vorher, BigDecimal nachher,
            List<String> vorherKennzeichen, List<String> nachherKennzeichen, String kennung, String methode) {}

    /** Methode e darf eine Menge bis zu einem Kalendermonat tragen. Sie erhält keine Viertelstundenanteile. */
    public static boolean periodenBetrag(Ersatzwert e, ZoneId zone) {
        return VerbrauchRegeln.WERT_EINGEBEN.equals(e.methode())
                && Duration.between(e.von(), e.bis()).compareTo(Duration.ofMinutes(15)) > 0
                && !e.bis().isAfter(e.von().atZone(zone).plusMonths(1).toInstant());
    }

    /** Gleiche Reihenfolge und Überschneidungsprüfung wie IP-13; nur der Periodenbetrag ist neu. */
    public static Geltende geltende(List<Ersatzwert> eingang, String regel, String einheit,
            Map<String, String> vorab, ZoneId zone) {
        List<Ersatzwert> normalisiert = eingang.stream().map(e -> {
            if (!periodenBetrag(e, zone)) return e;
            // Die Einzelprüfung bleibt IP-13. Ein kurzer Prüfträger prüft Methode und Einheit, keine Verteilung.
            return new Ersatzwert(e.kennung(), e.methode(), e.von(), e.von().plusSeconds(900), e.status(),
                    e.luecke(), e.lueckeVon(), e.profil(), e.profilEinheit(), e.betrag(), e.einheit(),
                    e.zeitpunkt(), e.endstand(), e.anfangsstand());
        }).toList();
        Map<String, String> abgelehnt = new LinkedHashMap<>();
        // Die volle Zeitspanne entscheidet über Konflikte, auch bei einem Betrag ohne Profil.
        List<Ersatzwert> sortiert = eingang.stream().filter(e -> VerbrauchRegeln.WIRKSAM.equals(e.status()))
                .sorted(java.util.Comparator.<Ersatzwert>comparingInt(e -> Integer.parseInt(e.kennung().split("-")[1]))
                        .thenComparingLong(e -> Long.parseLong(e.kennung().split("-")[2]))).toList();
        List<Geltend> aus = new ArrayList<>();
        for (Ersatzwert e : sortiert) {
            if (vorab.containsKey(e.kennung())) {
                abgelehnt.put(e.kennung(), vorab.get(e.kennung()));
                continue;
            }
            if (aus.stream().anyMatch(g -> g.ersatzwert().von().isBefore(e.bis())
                    && e.von().isBefore(g.ersatzwert().bis()))) {
                abgelehnt.put(e.kennung(), "ueberschneidet_ersatzwert");
                continue;
            }
            Ersatzwert pruefung = normalisiert.get(eingang.indexOf(e));
            Geltende einzel = VerbrauchRegeln.geltende(List.of(pruefung), regel, einheit, Map.of());
            if (!einzel.abgelehnt().isEmpty()) { abgelehnt.putAll(einzel.abgelehnt()); continue; }
            aus.add(new Geltend(e, periodenBetrag(e, zone) ? List.of() : einzel.gelten().get(0).anteile()));
        }
        return new Geltende(List.copyOf(aus), Map.copyOf(abgelehnt));
    }

    /** Nur ganz enthaltene Beiträge wirken. Angeschnittene Eingaben bleiben unverteilt (E7, kein Profil).
     * Bei vollständiger Ersetzung ist der neue Betrag die Menge; sonst Basis − alter Beitrag + neuer Beitrag.
     * Fehlende gemessene Beiträge werden nicht als Messwert 0 ausgegeben. Die Abdeckung bleibt gemessen.
     */
    public static Ergebnis anwenden(Ergebnis basis, Instant von, Instant bis, List<Beitrag> beitraege) {
        BigDecimal menge = basis.menge();
        List<String> kennzeichen = new ArrayList<>(basis.kennzeichen());
        boolean wirkt = false;
        for (Beitrag b : beitraege) {
            if (b.von().isBefore(von) || b.bis().isAfter(bis) || b.nachher() == null) continue;
            boolean ganz = b.von().equals(von) && b.bis().equals(bis);
            menge = ganz ? b.nachher() : (menge == null ? BigDecimal.ZERO : menge)
                    .subtract(b.vorher() == null ? BigDecimal.ZERO : b.vorher()).add(b.nachher());
            if (ganz) kennzeichen.clear();
            else kennzeichen.removeAll(b.vorherKennzeichen());
            for (String k : b.nachherKennzeichen()) {
                if (!ErgebnisZustand.istKorrigiert(k) && !kennzeichen.contains(k)) kennzeichen.add(k);
            }
            String satz = ErgebnisZustand.ersatzwert(b.methode(), b.kennung());
            if (!kennzeichen.contains(satz)) kennzeichen.add(satz);
            wirkt = true;
        }
        if (!wirkt) return basis;
        return new Ergebnis(menge, basis.mittel(), basis.min(), basis.max(), basis.energieKwh(),
                VerbrauchRegeln.MIT_ERSATZWERT, basis.erhalten(), basis.erwartet(), basis.abdeckungProzent(),
                List.copyOf(kennzeichen));
    }
}
