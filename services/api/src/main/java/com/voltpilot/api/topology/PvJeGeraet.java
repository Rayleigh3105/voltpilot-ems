package com.voltpilot.api.topology;

import com.voltpilot.api.web.dto.RollenDto;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.Map;
import java.util.UUID;

/**
 * Die PV einer Anlage nach der Je-Gerät-Regel (Schramm „Zuhause“, 07.11.2026): eine PV-Zuordnung ersetzt die
 * Zahl der BETEILIGTEN Geräte, nicht die der Anlage. So verspricht es der Rollen-Dialog („Ersetzt in der
 * Anlagen-Übersicht die PV-Zahl der beteiligten Geräte“), und so rechnet das Cockpit ({@code flussBilanz.ts}).
 * Bis dahin war die Zuordnung die ganze Sonne: bei Schramm nannte sie nur den PIKO (0,001 kW in der Dämmerung),
 * die Box maß mit den drei KACO 0,131 kW, und die Übersicht zeigte 0,001.
 *
 * <p><b>Anlagen-PV = PV der Box − Rohwert der zugeordneten Geräte + Wert der Zuordnung.</b> Eine Zuordnung am
 * eigenen PV-Kanal eines Geräts ändert die Zahl damit nicht. Ein Summenwert ersetzt genau die Geräte, denen er
 * zugeordnet ist, und zählt einmal: der Wert der Zuordnung ist die Zahl des Servers
 * ({@link RollenDto.KanonischerWert#wert()}), nie eine Summe der Gerätezeilen. Verbrauch und Netz ersetzen
 * weiterhin die Anlagenzahl (ein Teilverbrauch ist nur nach ausdrücklicher Wahl Verbrauch der Anlage).
 *
 * <p>Je Gerät ersetzt wird nur, wo die Topologie JEDES zugeordnete Gerät als Mitglied des PV-Knotens mit eigenem
 * Wert kennt - nur dann ist sein Anteil an der Box-Zahl bekannt. Sonst bleibt die Zuordnung die ganze Sonne, wie
 * bisher: ein Hybrid ohne eigene Reihe (seine PV IST die Box-Zahl), ein Zähler, der als Erzeugung zugeordnet ist
 * (er misst meist dieselbe Erzeugung wie die Wechselrichter). Dieselbe Regel wie im Cockpit ({@code flussBilanz.ts}).
 *
 * <p>Rein und rahmenfrei (getestet in {@code PvJeGeraetTest}).
 */
public final class PvJeGeraet {

    private PvJeGeraet() {}

    /**
     * @param rohPv       PV der Box (jüngste Standortprobe), {@code null} = unbekannt
     * @param pv          der kanonische PV-Wert der Anlage; ohne Zuordnung bleibt die Rohzahl
     * @param rohJeGeraet die Mitglieder des PV-Knotens der Topologie mit ihrem Rohwert (kW); {@code null} oder
     *                    fehlend = kein Mitglied bzw. ohne bekannten Wert (dann bleibt die Zuordnung die ganze Sonne)
     */
    public static BigDecimal anlagenPv(BigDecimal rohPv, RollenDto.KanonischerWert pv, Map<UUID, Double> rohJeGeraet) {
        if (pv == null || !pv.zuordnungVorhanden()) return rohPv;
        // Eine stumme Zuordnung bleibt unbekannt - nie die Rohzahl, nie 0 (Vertrag rollen-zuordnung.md).
        if (pv.wert() == null) return null;
        // Ohne Box-PV gibt es keine Zahl, in der ein Gerät zu ersetzen wäre: dann trägt die Zuordnung allein.
        if (rohPv == null) return BigDecimal.valueOf(pv.wert());
        var erfasst = pv.geraete().stream().map(RollenDto.GeraetBeitrag::entityId).distinct().toList();
        if (erfasst.stream().anyMatch(id -> rohJeGeraet.get(id) == null)) return BigDecimal.valueOf(pv.wert());
        double roh = erfasst.stream().mapToDouble(rohJeGeraet::get).sum();
        BigDecimal anlage = rohPv.subtract(BigDecimal.valueOf(roh)).add(BigDecimal.valueOf(pv.wert()));
        // Verschiedene Zeitbasen (Probe gegen 30-s-Mittel) dürfen keine negative Sonne ergeben.
        return anlage.max(BigDecimal.ZERO).setScale(3, RoundingMode.HALF_UP);
    }
}
