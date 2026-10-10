package com.voltpilot.writer;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Sammelt die Ereignisse EINES Umschlags und macht daraus so WENIGE Meldungen wie möglich
 * (UEMS AP-07 IP-7).
 *
 * <p>{@link MesswertHerkunft#stelleFest} urteilt je WERT — ein Umschlag mit 200 Werten würde also
 * 200-mal dieselbe Sequenz-Lücke melden. Diese Klasse bündelt, was zusammengehört, und hält sich
 * dabei an das geschlossene Vokabular des Ereignis-Vertrags
 * ({@code docs/contracts/v2/events-vocabulary.md}); erfunden wird nichts:
 *
 * <ul>
 *   <li>{@code sequence_gap} / {@code sequence_reset}: EINMAL je Umschlag — es ist die Sequenz des
 *       Umschlags, nicht die eines Werts.
 *   <li>{@code rejected}: EINMAL je Umschlag und Grund, mit {@code anzahl} (das Feld, das der
 *       Vertrag dafür führt).
 *   <li>{@code unassigned_reader}: EINMAL je Umschlag, Box und Datenquelle — als Zeitraum über die
 *       Messzeiten der gespiegelten Werte, mit {@code anzahl}. Zusätzlich gilt die Drossel des
 *       Vertrags: höchstens einmal je Stunde je Box und Datenquelle.
 *   <li>{@code duplicate_conflict}: je Wert — er nennt zwei konkrete Werte und zwei Sequenzen und
 *       ließe sich nicht bündeln, ohne genau das zu verlieren. Er ist der seltene Fall.
 *   <li>{@code clock_ahead}, {@code too_old}, {@code clock_jump}: NICHT vom Writer. Ihr Urheber ist
 *       die Datenannahme (Vokabular); sie werden verworfen und gezählt, nie hier gemeldet.
 * </ul>
 *
 * <p>Jede {@code ereignis_id} wird aus GESPEICHERTEN Fakten abgeleitet ({@code
 * UUID.nameUUIDFromBytes}) — ein erneut zugestellter Umschlag erzeugt deshalb dieselbe Meldung und
 * keine zweite Zeile.
 */
final class MesswertEreignisse {

    private static final JsonNodeFactory JSON = JsonNodeFactory.instance;

    /** Das Blatt des Uplink-Topics, aus dem diese Werte kamen (Vokabular {@code strom}). */
    private static final String STROM = "measurement-samples";

    private final MeasurementRawEvent event;
    private final List<ObjectNode> fertig = new ArrayList<>();
    private final Map<String, Integer> abgewiesen = new LinkedHashMap<>();
    private final Map<String, Spiegel> spiegel = new LinkedHashMap<>();
    private boolean sequenzGemeldet;
    private int fremd;

    MesswertEreignisse(MeasurementRawEvent event) {
        this.event = event;
    }

    private static final class Spiegel {
        private UUID datenquelle;
        private UUID komponente;
        private String messkanal;
        private String zustaendigeBox;
        private Instant von;
        private Instant bis;
        private int anzahl;
    }

    /** Die Ereignisse EINES Werts einsortieren. */
    void sammeln(HerkunftNachschlag.Urteil urteil, String pointKey, Instant messzeit) {
        for (MesswertHerkunft.Ereignis e : urteil.ergebnis().ereignisse()) {
            switch (e.art()) {
                case SEQUENCE_GAP, SEQUENCE_RESET -> {
                    if (!sequenzGemeldet) {
                        sequenzGemeldet = true;
                        fertig.add(sequenz(e));
                    }
                }
                case REJECTED -> abgewiesen.merge(String.valueOf(e.felder().get("grund")), 1,
                        Integer::sum);
                case UNASSIGNED_READER -> spiegeln(urteil, pointKey, messzeit);
                case DUPLICATE_CONFLICT -> fertig.add(konflikt(e, urteil));
                // clock_ahead / too_old / clock_jump gehören der Datenannahme (Vokabular).
                default -> fremd++;
            }
        }
    }

    /**
     * Nur den Widerspruch einsortieren. Der zweite Durchgang eines Werts (E3, nachdem die
     * Datenbank den Einfügeversuch abgewiesen hat) urteilt über DENSELBEN Wert noch einmal - er
     * darf deshalb keine Sequenz-Meldung, keine Abweisung und keinen zweiten Spiegel-Zähler
     * erzeugen, sondern genau das eine Ereignis, das der erste Durchgang noch nicht kennen konnte.
     */
    void sammelnNurKonflikt(HerkunftNachschlag.Urteil urteil, String pointKey) {
        for (MesswertHerkunft.Ereignis e : urteil.ergebnis().ereignisse()) {
            if (e.art() == MesswertHerkunft.EreignisArt.DUPLICATE_CONFLICT) {
                fertig.add(konflikt(e, urteil));
            }
        }
    }

    private void spiegeln(HerkunftNachschlag.Urteil urteil, String pointKey, Instant messzeit) {
        Spiegel s = spiegel.computeIfAbsent(
                urteil.dataSourceId().toString(), k -> new Spiegel());
        if (s.anzahl == 0) {
            s.datenquelle = urteil.dataSourceId();
            s.komponente = urteil.entityId();
            s.messkanal = pointKey;
            s.zustaendigeBox = urteil.zustaendigeBox();
            s.von = sekunden(messzeit);
            s.bis = sekunden(messzeit);
        } else {
            s.von = sekunden(messzeit).isBefore(s.von) ? sekunden(messzeit) : s.von;
            s.bis = sekunden(messzeit).isAfter(s.bis) ? sekunden(messzeit) : s.bis;
            // Mehrere Messkanäle in einer Meldung: der Kanal ist dann keine Aussage mehr.
            if (!pointKey.equals(s.messkanal)) {
                s.messkanal = null;
            }
        }
        s.anzahl++;
    }

    /**
     * Ein erkannter Überlauf (AP-08 IP-4) — EINE Meldung je Wert, mit der Rechnung als Nutzlast. Die
     * Kennung hängt an Reihe und Messzeit: ein erneut zugestellter Umschlag meldet ihn nicht zweimal.
     */
    void ueberlauf(HerkunftNachschlag.Urteil urteil, String pointKey, Instant messzeit, BigDecimal standNeu,
            UeberlaufErkennung.Ueberlauf u) {
        ObjectNode n = kopf("counter_overflow", UUID.nameUUIDFromBytes(("writer|counter_overflow|"
                + event.tenant_id() + "|" + urteil.entityId() + "|" + pointKey + "|" + messzeit)
                .getBytes(StandardCharsets.UTF_8)));
        setzen(n, "zeitpunkt", messzeit);
        n.put("komponente", urteil.entityId().toString());
        n.put("messkanal", pointKey);
        setzen(n, "stand_alt", u.standAlt());
        setzen(n, "stand_neu", standNeu);
        setzen(n, "messzeit_alt", u.messzeitAlt());
        setzen(n, "wertebereich_modul", u.wertebereichModul());
        setzen(n, "hoechstzuwachs_je_kadenz", u.hoechstzuwachsJeKadenz());
        n.put("kadenz_s", u.kadenzS());
        n.put("box", event.device_id().toString());
        if (urteil.messstelleId() != null) {
            n.put("messstelle", urteil.messstelleId().toString());
        }
        fertig.add(n);
    }

    /** Wie viele Meldungen die Datenannahme geschickt hat, die dem Writer nicht gehören. */
    int fremdeArten() {
        return fremd;
    }

    /** Die fertigen Meldungen dieses Umschlags, in der Reihenfolge, in der sie entstanden. */
    List<ObjectNode> meldungen() {
        List<ObjectNode> alle = new ArrayList<>(fertig);
        abgewiesen.forEach((grund, anzahl) -> alle.add(abweisung(grund, anzahl)));
        spiegel.values().forEach(s -> alle.add(spiegelMeldung(s)));
        return alle;
    }

    // ------------------------------------------------------------------ Die Meldungen

    private ObjectNode sequenz(MesswertHerkunft.Ereignis e) {
        ObjectNode n = kopf(e.art().code(),
                kennung("writer", e.art().code(), event.device_id(), event.sequence()));
        n.put("zeitpunkt", zeit(event.ingested_at()));
        n.put("box", event.device_id().toString());
        n.put("strom", STROM);
        e.felder().forEach((feld, wert) -> {
            if (!"box".equals(feld)) {
                setzen(n, feld, wert);
            }
        });
        return n;
    }

    private ObjectNode abweisung(String grund, int anzahl) {
        ObjectNode n = kopf("rejected",
                kennung("writer", "rejected|" + grund, event.device_id(), event.sequence()));
        n.put("zeitpunkt", zeit(event.ingested_at()));
        n.put("box", event.device_id().toString());
        n.put("strom", STROM);
        n.put("grund", grund);
        n.put("anzahl", anzahl);
        n.put("sequenz", event.sequence());
        return n;
    }

    private ObjectNode spiegelMeldung(Spiegel s) {
        ObjectNode n = kopf("unassigned_reader", UUID.nameUUIDFromBytes(("writer|unassigned_reader|"
                + event.tenant_id() + "|" + event.device_id() + "|" + s.datenquelle + "|"
                + event.ingested_at()).getBytes(StandardCharsets.UTF_8)));
        n.put("von", zeit(s.von));
        n.put("bis", zeit(s.bis));
        n.put("box", event.device_id().toString());
        n.put("datenquelle", s.datenquelle.toString());
        n.put("komponente", s.komponente.toString());
        if (s.messkanal != null) {
            n.put("messkanal", s.messkanal);
        }
        n.put("anzahl", s.anzahl);
        if (s.zustaendigeBox != null) {
            n.put("zustaendige_box", s.zustaendigeBox);
        }
        return n;
    }

    private ObjectNode konflikt(MesswertHerkunft.Ereignis e, HerkunftNachschlag.Urteil urteil) {
        Object messzeit = e.felder().get("messzeit");
        ObjectNode n = kopf("duplicate_conflict", UUID.nameUUIDFromBytes(
                ("writer|duplicate_conflict|" + event.tenant_id() + "|" + urteil.entityId() + "|"
                        + e.felder().get("messkanal") + "|" + messzeit + "|" + event.sequence())
                        .getBytes(StandardCharsets.UTF_8)));
        n.put("zeitpunkt", zeit(event.ingested_at()));
        n.put("box", event.device_id().toString());
        n.put("komponente", urteil.entityId().toString());
        setzen(n, "messkanal", e.felder().get("messkanal"));
        if (urteil.messstelleId() != null) {
            n.put("messstelle", urteil.messstelleId().toString());
        }
        e.felder().forEach((feld, wert) -> {
            if (!"box".equals(feld) && !"komponente".equals(feld) && !"messkanal".equals(feld)) {
                setzen(n, feld, wert);
            }
        });
        return n;
    }

    private static ObjectNode kopf(String art, UUID ereignisId) {
        ObjectNode n = JSON.objectNode();
        n.put("ereignis_id", ereignisId.toString());
        n.put("art", art);
        return n;
    }

    private static UUID kennung(String urheber, String art, UUID device, long sequenz) {
        return UUID.nameUUIDFromBytes((urheber + "|" + art + "|" + device + "|" + sequenz)
                .getBytes(StandardCharsets.UTF_8));
    }

    /**
     * Ein Wert des Vertrags als JSON — {@code Instant} auf die Sekunde (so schreibt der
     * Ereignis-Vertrag jede Zeit), Zahlen als Zahlen, alles andere als Text.
     */
    private static void setzen(ObjectNode n, String feld, Object wert) {
        n.set(feld, knoten(wert));
    }

    private static JsonNode knoten(Object wert) {
        if (wert == null) {
            return JSON.nullNode();
        }
        if (wert instanceof Instant t) {
            return JSON.textNode(zeit(t));
        }
        if (wert instanceof BigDecimal z) {
            return JSON.numberNode(z);
        }
        if (wert instanceof Integer z) {
            return JSON.numberNode(z);
        }
        if (wert instanceof Long z) {
            return JSON.numberNode(z);
        }
        if (wert instanceof Boolean b) {
            return JSON.booleanNode(b);
        }
        if (wert instanceof List<?> liste) {
            ArrayNode a = JSON.arrayNode();
            liste.forEach(x -> a.add(knoten(x)));
            return a;
        }
        if (wert instanceof Map<?, ?> karte) {
            ObjectNode o = JSON.objectNode();
            karte.forEach((k, v) -> o.set(String.valueOf(k), knoten(v)));
            return o;
        }
        return JSON.textNode(String.valueOf(wert));
    }

    private static String zeit(Instant t) {
        return sekunden(t).toString();
    }

    private static Instant sekunden(Instant t) {
        return t.truncatedTo(ChronoUnit.SECONDS);
    }
}
