package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Grenzart;
import java.math.BigDecimal;
import java.util.EnumMap;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Component;

/**
 * Die WIRKSAMEN Anteile je Box aus ihrem jüngsten Herzschlag-Block {@code gemeinsame_steuerung} (UEMS AP-15 IP-17,
 * Y3, A18; Vertrag {@code mqtt-plan-result.md} „Spiegel im Herzschlag“): {@code anteile_kw} mit beiden Richtungen, wie
 * die Box sie aus ihrem angenommenen Dokument meldet. Gefüttert vom {@link DataSourceStatusListener} nach der Topic-,
 * Payload- und Standort-Prüfung.
 *
 * <p><b>Im Prozess, nicht in der Datenbank</b>, wie {@code metrics/GemeinsameSteuerungHerzschlag}: nach einem Neustart
 * der API ist nichts bekannt, bis der nächste Herzschlag kommt — „unbekannt“ statt eines erfundenen Werts (dann
 * antwortet der Dienst nach einem Rückspielen {@code WIRKSAME_ANTEILE_UNBEKANNT}). Ein Block ohne Anteile, mit nur
 * einer Richtung, einer negativen oder unlesbaren Zahl löscht den Eintrag: unbekannt ist keine Null. Anders als die
 * Box-Metriken hängt diese Quelle an keinem Schalter — sie ist ein Eingang des Zweischritts.
 */
@Component
public class WirksameAnteileAusHerzschlag implements WirksameAnteileQuelle {

    private record Eintrag(UUID siteId, Map<Grenzart, BigDecimal> anteile) {}

    private final Map<UUID, Eintrag> jeBox = new ConcurrentHashMap<>();

    /** Übernimmt den Block eines gültigen Herzschlags der Box {@code deviceId} am Standort {@code siteId}. */
    public void merke(UUID siteId, UUID deviceId, JsonNode block) {
        if (siteId == null || deviceId == null) {
            return;
        }
        JsonNode kw = block == null ? null : block.get("anteile_kw");
        if (kw == null || !kw.isObject()) {
            jeBox.remove(deviceId);
            return;
        }
        Map<Grenzart, BigDecimal> anteile = new EnumMap<>(Grenzart.class);
        for (Grenzart r : SteuerungsverbundAnteile.RICHTUNGEN) {
            JsonNode wert = kw.get(r.code());
            if (wert == null || !wert.isNumber() || wert.decimalValue().signum() < 0) {
                jeBox.remove(deviceId);
                return;
            }
            anteile.put(r, wert.decimalValue());
        }
        jeBox.put(deviceId, new Eintrag(siteId, Map.copyOf(anteile)));
    }

    @Override
    public Optional<Map<Grenzart, BigDecimal>> wirksam(UUID siteId, UUID box) {
        Eintrag e = jeBox.get(box);
        return e == null || !e.siteId().equals(siteId) ? Optional.empty() : Optional.of(e.anteile());
    }
}
