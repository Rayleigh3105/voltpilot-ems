package com.voltpilot.writer;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

/**
 * RLS-scoped, idempotent persistence for validated measurements.raw events.
 *
 * <p>Every event this path newly writes to {@code device_measurement_event} it also writes to
 * {@code messreihe_ereignis} in the same transaction, inside its own savepoint ({@link
 * MessreiheEreignisRepository#spiegeln}, UEMS AP-07 IP-8) - the Bestand table stays exactly as
 * it was, its readers see nothing new, and a failing mirror is rolled back alone (logged,
 * counted) instead of taking this write with it.
 *
 * <h2>UEMS AP-07 IP-7: die Herkunft wird ZUR MESSZEIT nachgeschlagen</h2>
 *
 * Seit IP-7 hat dieser Weg ZWEI Spuren, und welche gilt, entscheidet EIN Fakt: hat die Komponente
 * des Messkanals eine Datenquelle?
 *
 * <ul>
 *   <li><b>Bestandswert</b> (keine eindeutige Komponente oder keine Datenquelle): Zeichen für
 *       Zeichen wie vorher - dieselben Spalten, derselbe alte Schlüssel
 *       {@code (device_id, point_key, time, edge_sequence)}, dieselben Nachwirkungen, kein
 *       Ereignis. Cockpit, Erlöse, Fahrplan, Verlauf, Verdichtungen und Registry-Push sehen
 *       nichts Neues.
 *   <li><b>UEMS-Messwert</b>: {@link HerkunftNachschlag} holt Gerät-Einbau, Fassung, Wertart und
 *       Rolle ZUR MESSZEIT (gecachte Zeitleisten), {@link MesswertHerkunft#stelleFest} fällt das
 *       Urteil des Vertrags, und die Zeile trägt ihre sieben Herkunftsspalten. Sie liegt damit im
 *       neuen Schlüssel {@code (tenant_id, entity_id, point_key, time)} - der Spiegel ausdrücklich
 *       ausserhalb.
 * </ul>
 *
 * <p><b>⚠ Ein Wert geht NIE verloren.</b> Scheitert ein Nachschlag, gibt er {@code null} zurück
 * (eigener Savepoint, geloggt, gezählt) und der Wert wird als Bestandswert gespeichert. Weist der
 * Vertrag ihn als {@code rejected} ab (Herkunft unvollständig), wird er ebenfalls als Bestandswert
 * gespeichert und die Abweisung nur BERICHTET: „kein Messwert des Unternehmens-Energiemanagements"
 * heißt „nicht in der Reihe", nie „gelöscht". Nur der eine Fall, den E3 dafür vorsieht, schreibt
 * wirklich nichts: derselbe Schlüssel mit einem ABWEICHENDEN Wert - dort bleibt der erste stehen
 * und der zweite wird als {@code duplicate_conflict} festgehalten.
 */
@Repository
public class MeasurementWriteRepository {

    /** Die Metrik, an der das Urteil des Herkunftsvertrags je Wert ablesbar ist. */
    static final String URTEIL_METRIK = "voltpilot.writer.herkunft.urteil";

    /** Wie viele Boxen ihren zuletzt gesehenen Umschlag im Speicher behalten (LRU). */
    static final int UMSCHLAEGE = 4_096;

    private final JdbcTemplate jdbc;
    private final MessreiheEreignisRepository ereignisse;
    private final HerkunftNachschlag nachschlag;
    private final MeterRegistry meters;

    /**
     * Der zuletzt gesehene Umschlag JE BOX (Vertrag §3 Regel 2). Er lebt im Speicher: das kostet
     * keine einzige Abfrage, und nach einem Neustart urteilt der erste Umschlag einer Box gar
     * nicht über die Sequenz - lieber KEIN Ereignis als eine erfundene Lücke.
     */
    private final Map<UUID, MesswertHerkunft.VorherigerUmschlag> umschlaege =
            Collections.synchronizedMap(new LinkedHashMap<>(256, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(
                        Map.Entry<UUID, MesswertHerkunft.VorherigerUmschlag> eldest) {
                    return size() > UMSCHLAEGE;
                }
            });

    record Meta(String selectionKey, boolean enabled, Instant enabledAt, Instant disabledAt,
            String applyStatus, Instant appliedAt, String aggregationKind, Integer cadence) {}

    /** numeric/text as COALESCE(decoded, raw) per type (the Bestand columns); value like Value.prefer. */
    record Previous(BigDecimal numeric, String text, String quality, Value value) {}

    record Value(BigDecimal numeric, String text) {
        static Value prefer(Value decoded, Value raw) {
            return decoded.numeric != null || decoded.text != null ? decoded : raw;
        }
    }

    public MeasurementWriteRepository(JdbcTemplate jdbc, MessreiheEreignisRepository ereignisse,
            HerkunftNachschlag nachschlag, MeterRegistry meters) {
        this.jdbc = jdbc;
        this.ereignisse = ereignisse;
        this.nachschlag = nachschlag;
        this.meters = meters;
    }

    @Transactional
    public int insert(MeasurementRawEvent event) {
        jdbc.queryForObject("SELECT set_config('app.tenant_id', ?, true)", String.class,
                event.tenant_id().toString());
        List<Instant> purgeRows = jdbc.query("SELECT data_purged_before FROM device "
                        + "WHERE id=? FOR SHARE",
                (rs, row) -> instant(rs.getTimestamp(1)), event.device_id());
        if (purgeRows.isEmpty()) {
            return 0;
        }
        Instant purgedBefore = purgeRows.get(0);
        // Der zuletzt gesehene Umschlag DIESER Box - und ab jetzt ist es dieser.
        MesswertHerkunft.VorherigerUmschlag vorher = umschlaege.put(event.device_id(),
                new MesswertHerkunft.VorherigerUmschlag(event.sequence(), event.observed_at()));
        MesswertEreignisse sammler = new MesswertEreignisse(event);

        int rows = 0;
        for (JsonNode sample : event.samples()) {
            String pointKey = sample.path("point_key").asText();
            Instant observedAt = sampleTime(sample, event.observed_at());
            Meta meta = metadata(event, pointKey);
            // Die Reihe (E2): Komponente + Datenquelle des Messkanals. EIN gecachter Nachschlag
            // je Messkanal - er wächst mit der Zahl der Kanäle, nie mit der Zahl der Werte.
            HerkunftNachschlag.Reihe reihe = meta == null ? null
                    : nachschlag.reihe(event, pointKey, templateKey(pointKey));
            boolean uems = reihe != null && reihe.uems();
            // ⚠ Diese Prüfung ist UNVERÄNDERT, und das ist die Auflösung von W8, nicht ihr
            // Gegenteil: `enabled_at`, `disabled_at` und das Purge-Wasserzeichen werden schon
            // immer gegen die MESSZEIT geprüft - sie sind die Frage "war der Punkt damals
            // gewählt?". Was IP-7 dazunimmt, ist die Zuständigkeit ZUR MESSZEIT, und die
            // verwirft NIE: sie entscheidet nur die Rolle. Ein Puffer, der Stunden nach einer
            // Übergabe eintrifft, ist deshalb willkommen (bis 90 Tage zurück) und führend,
            // wenn seine Box damals zuständig war.
            if (meta == null || observedAt == null || atOrBefore(observedAt, purgedBefore)
                    || meta.enabledAt() == null
                    || observedAt.isBefore(meta.enabledAt()) || !withinCutover(meta, observedAt)) {
                continue;
            }

            JsonNode rawNode = sample.get("raw");
            JsonNode decodedNode = sample.get("decoded");
            if (rawNode == null || !scalar(rawNode)) {
                continue;
            }
            Value raw = value(rawNode);
            Value decoded = decodedNode != null && scalar(decodedNode)
                    ? value(decodedNode) : new Value(null, null);
            String quality = sample.path("quality").asText();

            HerkunftNachschlag.Urteil urteil = uems
                    ? nachschlag.beurteilen(eingang(event, reihe, pointKey, observedAt, raw,
                            decoded, quality, meta, vorher, List.of()))
                    : null;
            MesswertHerkunft.Herkunft herkunft = gespeicherteHerkunft(urteil);
            if (urteil != null) {
                sammler.sammeln(urteil, pointKey, observedAt);
            }
            int inserted = schreiben(event, sample, pointKey, observedAt, raw, decoded, quality,
                    meta, urteil, herkunft);
            HerkunftNachschlag.Urteil endgueltig = urteil;
            if (inserted == 0 && herkunft != null) {
                // E3 am lebenden Schlüssel: die Datenbank hat abgewiesen. Liegt dort DERSELBE
                // Wert (Wiederholung - gezählt, kein Ereignis) oder ein WIDERSPRUCH
                // (duplicate_conflict)? Das ist die EINZIGE Abfrage je Wert in diesem Paket,
                // und sie entsteht nur, wenn wirklich schon etwas liegt.
                HerkunftNachschlag.Urteil zweit = nachschlag.beurteilen(eingang(event, reihe,
                        pointKey, observedAt, raw, decoded, quality, meta, null,
                        nachschlag.gespeichertZurMesszeit(event, urteil.entityId(), pointKey,
                                observedAt)));
                if (zweit != null) {
                    sammler.sammelnNurKonflikt(zweit, pointKey);
                    // Gezählt wird das ENDGÜLTIGE Urteil: der erste Durchgang wusste noch nicht,
                    // dass dort schon etwas liegt.
                    endgueltig = zweit;
                }
            }
            if (endgueltig != null) {
                urteilGezaehlt(endgueltig, gespeicherteHerkunft(endgueltig));
            }
            if (inserted > 0) {
                updatePointState(event, pointKey, observedAt, raw, decoded, quality);
                appendTransitions(event, pointKey, observedAt, raw, decoded, quality, meta);
                markFirstSample(event, meta.selectionKey(), observedAt);
                rows++;
            }
        }
        if ((event.gap() || event.dropped_samples() > 0)
                && !atOrBefore(event.observed_at(), purgedBefore)) {
            insertGap(event);
        }
        melden(event, sammler);
        return rows;
    }

    /** Die Herkunft, die WIRKLICH in die Zeile gehört - nur bei Urteil „gespeichert". */
    private static MesswertHerkunft.Herkunft gespeicherteHerkunft(HerkunftNachschlag.Urteil u) {
        return u != null && u.ergebnis().urteil() == MesswertHerkunft.Urteil.GESPEICHERT
                ? u.ergebnis().herkunft() : null;
    }

    private HerkunftNachschlag.Eingang eingang(MeasurementRawEvent event,
            HerkunftNachschlag.Reihe reihe, String pointKey, Instant observedAt, Value raw,
            Value decoded, String quality, Meta meta,
            MesswertHerkunft.VorherigerUmschlag vorher,
            List<MesswertHerkunft.Gespeichert> gespeichert) {
        return new HerkunftNachschlag.Eingang(event, reihe, pointKey, templateKey(pointKey),
                observedAt, drahtwert(raw), drahtwert(decoded), quality, meta.aggregationKind(),
                vorher, gespeichert);
    }

    /** Der Wert, wie er am Draht stand: die Zahl, sonst der Text, sonst nichts. */
    private static Object drahtwert(Value v) {
        return v.numeric() != null ? v.numeric() : v.text();
    }

    /**
     * Schreibt EINE Zeile. Ohne Herkunft sind die sieben neuen Spalten {@code null} - das ist
     * dieselbe Zeile wie vor IP-7, nur ausdrücklich hingeschrieben. {@code ON CONFLICT DO NOTHING}
     * ohne Ziel sieht BEIDE Schlüssel: den alten (Bestand, Spiegel-Spur) und den neuen
     * (Reihe + Messzeit der zuständigen Spur) - er ist der Wettlauf-Schutz unter dem Urteil.
     */
    private int schreiben(MeasurementRawEvent event, JsonNode sample, String pointKey,
            Instant observedAt, Value raw, Value decoded, String quality, Meta meta,
            HerkunftNachschlag.Urteil urteil, MesswertHerkunft.Herkunft herkunft) {
        return jdbc.update("INSERT INTO device_measurement_sample "
                        + "(time,received_at,tenant_id,site_id,device_id,point_key,raw_numeric,"
                        + "raw_text,decoded_numeric,decoded_text,quality,catalog_version,"
                        + "edge_sequence,aggregation_kind,long_term_cadence_s,gap,dropped_samples,"
                        + "signed_data,signed_data_format,entity_id,device_install_id,"
                        + "applied_revision,value_kind,role,delivery,delay_s) "
                        + "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
                        + "ON CONFLICT DO NOTHING",
                Timestamp.from(observedAt), Timestamp.from(event.ingested_at()),
                event.tenant_id(), event.site_id(), event.device_id(), pointKey,
                raw.numeric(), raw.text(), decoded.numeric(), decoded.text(),
                quality, event.catalog_version(), event.sequence(),
                meta.aggregationKind(), meta.cadence(), event.gap(), event.dropped_samples(),
                text(sample, "signed_data"), text(sample, "signed_data_format"),
                herkunft == null ? null : urteil.entityId(),
                herkunft == null ? null : urteil.geraetId(),
                herkunft == null ? null : (long) herkunft.einstellungsFassung().fassung(),
                herkunft == null ? null : herkunft.wertart(),
                herkunft == null ? null : herkunft.rolle().code(),
                herkunft == null ? null : herkunft.zustellart().art().code(),
                herkunft == null ? null : sekunden(herkunft.zustellart().verzoegerungS()));
    }

    /** Die Verzögerung als {@code integer} der Spalte; sie liegt immer zwischen -300 s und 90 Tagen. */
    private static int sekunden(long verzoegerung) {
        return (int) Math.max(Integer.MIN_VALUE, Math.min(Integer.MAX_VALUE, verzoegerung));
    }

    /**
     * Hängt die Meldungen dieses Umschlags an - jede in ihrem eigenen Savepoint, keine kann den
     * Schreibweg mitreissen. Ein angehängter {@code unassigned_reader} startet zugleich die Stunde
     * seiner Drossel.
     */
    private void melden(MeasurementRawEvent event, MesswertEreignisse sammler) {
        if (sammler.fremdeArten() > 0) {
            ereignisse.nichtVomWriter(sammler.fremdeArten());
        }
        for (ObjectNode meldung : sammler.meldungen()) {
            ereignisse.vomWriter(event.tenant_id(), event.site_id(), meldung, event.ingested_at());
            if ("unassigned_reader".equals(meldung.path("art").asText())) {
                nachschlag.unassignedReaderGemerkt(event.tenant_id(), event.device_id(),
                        UUID.fromString(meldung.path("datenquelle").asText()),
                        event.ingested_at());
            }
        }
    }

    private void urteilGezaehlt(HerkunftNachschlag.Urteil urteil,
            MesswertHerkunft.Herkunft herkunft) {
        Counter.builder(URTEIL_METRIK)
                .description("Urteil des Herkunftsvertrags je Messwert (AP-07 IP-7)")
                .tag("urteil", urteil.ergebnis().urteil().code())
                .tag("grund", urteil.ergebnis().grund() == null ? ""
                        : urteil.ergebnis().grund().code())
                .tag("rolle", herkunft == null ? "" : herkunft.rolle().code())
                .register(meters)
                .increment();
    }

    private void updatePointState(MeasurementRawEvent event, String pointKey, Instant observedAt,
            Value raw, Value decoded, String quality) {
        jdbc.update("INSERT INTO device_measurement_point_state (tenant_id,site_id,device_id,"
                        + "point_key,first_read_at,last_read_at,edge_sequence,raw_numeric,raw_text,"
                        + "decoded_numeric,decoded_text,quality,gap,dropped_samples,catalog_version) "
                        + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT "
                        + "(tenant_id,site_id,device_id,point_key) DO UPDATE SET "
                        + "first_read_at=LEAST(device_measurement_point_state.first_read_at,"
                        + "EXCLUDED.first_read_at),last_read_at=EXCLUDED.last_read_at,"
                        + "edge_sequence=EXCLUDED.edge_sequence,raw_numeric=EXCLUDED.raw_numeric,"
                        + "raw_text=EXCLUDED.raw_text,decoded_numeric=EXCLUDED.decoded_numeric,"
                        + "decoded_text=EXCLUDED.decoded_text,quality=EXCLUDED.quality,gap=EXCLUDED.gap,"
                        + "dropped_samples=EXCLUDED.dropped_samples,catalog_version=EXCLUDED.catalog_version "
                        + "WHERE (EXCLUDED.last_read_at,EXCLUDED.edge_sequence) > "
                        + "(device_measurement_point_state.last_read_at,"
                        + "device_measurement_point_state.edge_sequence)",
                event.tenant_id(), event.site_id(), event.device_id(), pointKey,
                Timestamp.from(observedAt), Timestamp.from(observedAt), event.sequence(),
                raw.numeric(), raw.text(), decoded.numeric(), decoded.text(), quality,
                event.gap(), event.dropped_samples(), event.catalog_version());
    }

    private Meta metadata(MeasurementRawEvent event, String pointKey) {
        String template = templateKey(pointKey);
        List<Meta> rows = jdbc.query("SELECT s.point_key,s.enabled,s.enabled_at,s.disabled_at,s.apply_status,"
                        + "s.applied_at,"
                        + "COALESCE(m.aggregation_kind,CASE s.retention_class "
                        + "WHEN 'energy_counter' THEN 'counter' WHEN 'state_event' THEN 'event' "
                        + "WHEN 'identity_configuration' THEN 'text' WHEN 'unclassified' THEN 'none' "
                        + "ELSE 'gauge' END),COALESCE(m.long_term_cadence_s,s.long_term_cadence_s) "
                        + "FROM device_measurement_selection s "
                        + "LEFT JOIN LATERAL (SELECT m.aggregation_kind,m.long_term_cadence_s "
                        + "FROM measurement_catalog_point_metadata m "
                        + "WHERE m.catalog_version=? AND m.point_key IN (s.point_key,?) "
                        + "ORDER BY CASE WHEN m.point_key=s.point_key THEN 0 ELSE 1 END LIMIT 1) m ON true "
                        + "WHERE s.device_id=? AND s.point_key IN (?,?) "
                        + "ORDER BY CASE WHEN s.point_key=? THEN 0 ELSE 1 END LIMIT 1",
                (rs, n) -> new Meta(rs.getString(1), rs.getBoolean(2), instant(rs.getTimestamp(3)),
                        instant(rs.getTimestamp(4)), rs.getString(5), instant(rs.getTimestamp(6)),
                        rs.getString(7), (Integer) rs.getObject(8)),
                event.catalog_version(), template, event.device_id(), pointKey, template, pointKey);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private static boolean withinCutover(Meta meta, Instant observedAt) {
        if (meta.enabled()) {
            return !"rejected".equals(meta.applyStatus());
        }
        Instant cutover = meta.appliedAt() != null ? meta.appliedAt() : meta.disabledAt();
        return cutover != null && !observedAt.isAfter(cutover.plusSeconds(30));
    }

    private void appendTransitions(MeasurementRawEvent event, String pointKey, Instant at,
            Value raw, Value decoded, String quality, Meta meta) {
        List<Previous> rows = jdbc.query("SELECT decoded_numeric,decoded_text,raw_numeric,raw_text,"
                        + "quality FROM device_measurement_sample "
                        + "WHERE tenant_id=? AND site_id=? AND device_id=? AND point_key=? AND "
                        + "(time<? OR (time=? AND edge_sequence<?)) "
                        + "ORDER BY time DESC,edge_sequence DESC LIMIT 1",
                (rs, n) -> {
                    Value dec = new Value(rs.getBigDecimal(1), rs.getString(2));
                    Value was = new Value(rs.getBigDecimal(3), rs.getString(4));
                    return new Previous(dec.numeric() != null ? dec.numeric() : was.numeric(),
                            dec.text() != null ? dec.text() : was.text(), rs.getString(5),
                            Value.prefer(dec, was));
                },
                event.tenant_id(), event.site_id(), event.device_id(), pointKey,
                Timestamp.from(at), Timestamp.from(at), event.sequence());
        Previous previous = rows.isEmpty() ? null : rows.get(0);
        if (previous == null) {
            return;
        }

        Value current = Value.prefer(decoded, raw);
        boolean changed = numericChanged(previous.numeric(), current.numeric())
                || !Objects.equals(previous.text(), current.text());
        String eventKind = null;
        if ("counter".equals(meta.aggregationKind()) && previous.numeric() != null
                && current.numeric() != null && current.numeric().compareTo(previous.numeric()) < 0) {
            eventKind = "counter_reset";
        } else if (changed && "bitfield".equals(meta.aggregationKind())) {
            eventKind = "bitfield_change";
        } else if (changed && "text".equals(meta.aggregationKind())) {
            eventKind = "text_change";
        } else if (changed && ("state".equals(meta.aggregationKind())
                || "event".equals(meta.aggregationKind()))) {
            eventKind = "state_change";
        }
        if (!Objects.equals(previous.quality(), quality)) {
            insertEvent(event, pointKey, at, "error_change", previous.numeric(),
                    current.numeric(), previous.quality(), quality, "{}",
                    nutzlast().put("alt", previous.quality()).put("neu", quality));
        }
        if (eventKind != null) {
            String details = "bitfield_change".equals(eventKind)
                    ? bitfieldDetails(previous.numeric(), current.numeric()) : "{}";
            ObjectNode nutzlast = "counter_reset".equals(eventKind)
                    ? nutzlast().put("stand_alt", previous.numeric()).put("stand_neu", current.numeric())
                    : wert(wert(nutzlast(), "alt", previous.value()), "neu", current);
            insertEvent(event, pointKey, at, eventKind, previous.numeric(), current.numeric(),
                    previous.text(), current.text(), details, nutzlast);
        }
    }

    private void insertGap(MeasurementRawEvent event) {
        // The box displaced values (Verdraengung): it is the box's gap, counted when it counted.
        ObjectNode nutzlast = nutzlast().put("erkannt_aus", "verdraengung");
        if (event.dropped_samples() > 0) {
            nutzlast.put("erwartet_fehlend", event.dropped_samples());
        }
        insertEvent(event, "_pipeline", event.observed_at(), "data_gap", null, null, null, null,
                "{\"dropped_samples\":" + event.dropped_samples() + "}", nutzlast);
    }

    /**
     * Writes the Bestand row and - only when it was new - its mirror in messreihe_ereignis
     * (same transaction, own savepoint; the mirror never throws). A redelivery hits the Bestand
     * ON CONFLICT and mirrors nothing.
     */
    private void insertEvent(MeasurementRawEvent event, String pointKey, Instant at, String kind,
            BigDecimal previousNumeric, BigDecimal valueNumeric, String previousText, String valueText,
            String details, ObjectNode nutzlast) {
        int inserted = jdbc.update("INSERT INTO device_measurement_event(occurred_at,tenant_id,site_id,device_id,"
                        + "point_key,event_kind,previous_numeric,value_numeric,previous_text,value_text,"
                        + "catalog_version,edge_sequence,details) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?::jsonb) "
                        + "ON CONFLICT DO NOTHING",
                Timestamp.from(at), event.tenant_id(), event.site_id(), event.device_id(), pointKey,
                kind, previousNumeric, valueNumeric, previousText, valueText, event.catalog_version(),
                event.sequence(), details);
        if (inserted > 0) {
            ereignisse.spiegeln(event, pointKey, at, kind, nutzlast);
        }
    }

    private static ObjectNode nutzlast() {
        return JsonNodeFactory.instance.objectNode();
    }

    /** The contract's alt/neu of a transition: the number, else the text (never both). */
    private static ObjectNode wert(ObjectNode node, String feld, Value v) {
        return v.numeric() != null ? node.put(feld, v.numeric()) : node.put(feld, v.text());
    }

    private void markFirstSample(MeasurementRawEvent event, String pointKey, Instant at) {
        int changed = jdbc.update("UPDATE device_measurement_selection SET apply_status='first_sample',"
                        + "apply_reason='Erster Wert gespeichert.',applied_at=COALESCE(applied_at,?) "
                        + "WHERE device_id=? AND point_key=? AND enabled "
                        + "AND apply_status<>'first_sample'",
                Timestamp.from(at), event.device_id(), pointKey);
        if (changed == 0) {
            return;
        }
        jdbc.update("INSERT INTO device_measurement_selection_event(tenant_id,site_id,device_id,"
                        + "point_key,desired_revision,event_kind,requested_at,requested_enabled,"
                        + "requested_cadence_s,enabled_at,disabled_at,catalog_version,actor,apply_status,"
                        + "apply_reason,applied_at,custom_definition,retention_class,raw_retention_days,"
                        + "long_term_cadence_s,long_term_strategy) SELECT tenant_id,site_id,device_id,"
                        + "point_key,desired_revision,'first_sample',?,enabled,cadence_s,enabled_at,"
                        + "disabled_at,catalog_version,'writer','first_sample','Erster Wert gespeichert.',"
                        + "?,custom_definition,retention_class,raw_retention_days,long_term_cadence_s,"
                        + "long_term_strategy FROM device_measurement_selection "
                        + "WHERE device_id=? AND point_key=? ON CONFLICT DO NOTHING",
                Timestamp.from(at), Timestamp.from(at), event.device_id(), pointKey);
    }

    private static Value value(JsonNode node) {
        if (node.isNumber()) {
            return new Value(node.decimalValue(), null);
        }
        return new Value(null, node.isTextual() ? node.asText()
                : Boolean.toString(node.asBoolean()));
    }

    private static boolean scalar(JsonNode node) {
        return node.isNumber() || node.isTextual() || node.isBoolean();
    }

    private static Instant sampleTime(JsonNode sample, Instant fallback) {
        try {
            return sample.has("observed_at")
                    ? Instant.parse(sample.get("observed_at").asText()) : fallback;
        } catch (Exception ignored) {
            return null;
        }
    }

    private static Instant instant(Timestamp timestamp) {
        return timestamp == null ? null : timestamp.toInstant();
    }

    private static boolean atOrBefore(Instant value, Instant watermark) {
        return watermark != null && !value.isAfter(watermark);
    }

    private static String bitfieldDetails(BigDecimal previous, BigDecimal current) {
        if (previous == null || current == null || previous.signum() < 0 || current.signum() < 0) {
            return "{}";
        }
        try {
            BigInteger before = previous.toBigIntegerExact();
            BigInteger after = current.toBigIntegerExact();
            return "{\"set_bits\":" + after.andNot(before)
                    + ",\"cleared_bits\":" + before.andNot(after) + "}";
        } catch (ArithmeticException e) {
            return "{}";
        }
    }

    static String templateKey(String pointKey) {
        return pointKey == null ? null : pointKey.replaceAll("\\[[^]\\r\\n]+]", "[*]");
    }

    private static boolean numericChanged(BigDecimal before, BigDecimal after) {
        return before == null || after == null ? before != after : before.compareTo(after) != 0;
    }

    private static String text(JsonNode node, String field) {
        return node.has(field) && node.get(field).isTextual() ? node.get(field).asText() : null;
    }
}
