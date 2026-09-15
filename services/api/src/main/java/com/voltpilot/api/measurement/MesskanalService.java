package com.voltpilot.api.measurement;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementCatalog.Semantik;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.uems.GeraetRepository;
import com.voltpilot.api.uems.KadenzRegeln;
import com.voltpilot.api.uems.MessstelleQuelleRepository;
import com.voltpilot.api.uems.MessstelleService;
import com.voltpilot.api.web.dto.MesskanalDto;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Das Messkanal-Read-Model je Komponente (UEMS AP-04 IP-9): jede Zeile der Mess-Selektion der
 * Komponente mit den Fakten, die eine Quellenbindung braucht — aus dem Katalog Anzeigename,
 * Einheit, Wertart, Größe und Richtung ({@link MesskanalAbbildung}), aus der Selektion Kadenz,
 * Zustand und lesende Box, aus der Geräte-Historie das Gerät, das die Komponente gerade speist
 * (IP-10, {@link GeraetRepository#laufenderDerKomponente}) — für jeden Kanal dasselbe, denn
 * der Einbau hängt an der Komponente, nicht am Kanal —, und aus den Quellenbindungen (IP-13,
 * {@link MessstelleQuelleRepository#derKomponenteAm}) je Kanal, welche Messstellen er zum
 * Stichtag speist.
 *
 * <p>Der Mandant ist die RLS: die App-Rolle sieht nur die eigenen Standorte, Komponenten und
 * Selektionen, eine fremde Komponente ist 404, nie 403 — und eine Komponente eines ANDEREN
 * eigenen Standorts unter diesem Standort ebenso. Die Selektion wird bewusst nur über
 * {@code entity_id} gelesen: sie ist an (Komponente, Mandant) gebunden, nicht an den Standort
 * (V20260855000000 — eine Komponente behält ihre Kanäle über einen Umzug).
 */
@Service
public class MesskanalService {

    private final JdbcTemplate jdbc;
    private final Geltungsbereich geltungsbereich;
    private final MeasurementCatalog catalog;
    private final ObjectMapper json;
    private final GeraetRepository geraete;
    private final MessstelleQuelleRepository quellen;

    public MesskanalService(JdbcTemplate jdbc, Geltungsbereich geltungsbereich, MeasurementCatalog catalog,
            ObjectMapper json, GeraetRepository geraete, MessstelleQuelleRepository quellen) {
        this.jdbc = jdbc;
        this.geltungsbereich = geltungsbereich;
        this.catalog = catalog;
        this.json = json;
        this.geraete = geraete;
        this.quellen = quellen;
    }

    private record Zeile(UUID deviceId, String pointKey, boolean enabled, Integer cadenceS,
            String customDefinition) {}

    public MesskanalDto.Liste messkanaele(UUID siteId, UUID komponente) {
        return messkanaele(siteId, komponente, Instant.now());
    }

    /**
     * Die Kanäle der Komponente; {@code speist} nennt je Kanal die Quellenbindungen, die zum
     * {@code stichtag} laufen (IP-13) — „speist MS-06 (führend)“.
     */
    public MesskanalDto.Liste messkanaele(UUID siteId, UUID komponente, Instant stichtag) {
        List<UUID> standort = jdbc.query("SELECT site_id FROM measurement_point WHERE id = ?",
                (rs, n) -> rs.getObject(1, UUID.class), komponente);
        if (!geltungsbereich.siteVisible(siteId) || standort.isEmpty() || !siteId.equals(standort.get(0))) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Komponente nicht gefunden.");
        }
        List<Zeile> zeilen = jdbc.query("""
                SELECT s.device_id, s.point_key, s.enabled, s.cadence_s, s.custom_definition::text AS custom
                  FROM device_measurement_selection s
                  JOIN device d ON d.id = s.device_id AND d.ausgebaut_am IS NULL
                 WHERE s.entity_id = ?
                 ORDER BY s.point_key, s.device_id
                """, (rs, n) -> new Zeile(rs.getObject("device_id", UUID.class),
                        rs.getString("point_key"), rs.getBoolean("enabled"),
                        (Integer) rs.getObject("cadence_s"), rs.getString("custom")), komponente);
        MesskanalDto.GeraetEinbau geraet = geraete.laufenderDerKomponente(komponente)
                .map(e -> new MesskanalDto.GeraetEinbau(e.id(), e.kennzeichen(), e.einbauKennzeichen(),
                        e.seriennummer()))
                .orElse(null);
        Map<String, List<MesskanalDto.Speist>> speist = new LinkedHashMap<>();
        for (MessstelleQuelleRepository.Quelle q : quellen.derKomponenteAm(komponente, stichtag)) {
            speist.computeIfAbsent(q.kanal(), k -> new ArrayList<>()).add(new MesskanalDto.Speist(
                    q.messstelleId(), q.messstelle(), q.groesse(), q.richtung(), q.rolle(), q.zweck(),
                    zeit(q.gueltigAb()), zeit(q.gueltigBis())));
        }
        return new MesskanalDto.Liste(siteId, komponente, catalog.inhaltsstand(),
                zeilen.stream().map(z -> kanal(z, geraet, speist.getOrDefault(z.pointKey(), List.of()))).toList());
    }

    /**
     * EIN Kanal der Komponente — was die Quellenbindung (IP-13) über den Messwert wissen muss:
     * Größe, Richtung, Einheit und Wertart in den Wörtern des Vertrags. Leer, wenn die Komponente
     * diesen Kanal nicht hat (keine Zeile der Mess-Selektion); unter RLS ist eine fremde Komponente
     * ohnehin leer. Liest eine zweite Box denselben Kanal, sagt der Katalog für beide dasselbe.
     */
    public Optional<MesskanalDto.Messkanal> kanal(UUID komponente, String pointKey) {
        return jdbc.query("""
                SELECT s.device_id, s.point_key, s.enabled, s.cadence_s, s.custom_definition::text AS custom
                  FROM device_measurement_selection s
                  JOIN device d ON d.id = s.device_id AND d.ausgebaut_am IS NULL
                 WHERE s.entity_id = ? AND s.point_key = ?
                 ORDER BY s.device_id
                 LIMIT 1
                """, (rs, n) -> new Zeile(rs.getObject("device_id", UUID.class),
                        rs.getString("point_key"), rs.getBoolean("enabled"),
                        (Integer) rs.getObject("cadence_s"), rs.getString("custom")), komponente, pointKey)
                .stream().findFirst().map(z -> kanal(z, null, List.of()));
    }

    private MesskanalDto.Messkanal kanal(Zeile z, MesskanalDto.GeraetEinbau geraet,
            List<MesskanalDto.Speist> speist) {
        if (z.customDefinition() != null) {
            // Selbstbau: Name und Einheit aus der eigenen Definition; eine Wertart, Größe oder
            // Richtung trägt sie (noch) nicht — also keine.
            JsonNode d = lesen(z.customDefinition());
            return new MesskanalDto.Messkanal(z.pointKey(), text(d, "label"), text(d, "unit"),
                    null, null, null, null, null, z.cadenceS(), z.enabled(), z.deviceId(), geraet, speist);
        }
        MeasurementCatalog.Point p = catalog.resolve(z.pointKey());
        Semantik s = catalog.semantik(z.pointKey());
        String quantity = s == null ? null : s.quantity();
        String direction = s == null ? null : s.direction();
        return new MesskanalDto.Messkanal(z.pointKey(), katalogName(p), p == null ? null : p.unit(),
                p == null ? null : MesskanalAbbildung.wertart(p.aggregationKind()),
                MesskanalAbbildung.groesse(quantity), MesskanalAbbildung.richtung(direction),
                quantity, direction, z.cadenceS(), z.enabled(), z.deviceId(), geraet, speist);
    }

    /**
     * Der Anzeigename eines Kanals, wie ihn jede Zeile dieses Read-Models nennt: aus der eigenen
     * Definition (Selbstbau, {@code custom_definition} der Mess-Selektion) oder aus dem Katalog;
     * {@code null}, wenn keine von beiden einen Namen trägt. Auch das Messstellen-Register (IP-4)
     * nennt die Quelle so.
     */
    public String anzeigename(String pointKey, JsonNode eigeneDefinition) {
        if (eigeneDefinition != null && !eigeneDefinition.isNull()) {
            return text(eigeneDefinition, "label");
        }
        return katalogName(catalog.resolve(pointKey));
    }

    /**
     * Die Einheit eines Kanals, nach derselben Regel wie {@link #anzeigename}: aus der eigenen
     * Definition (Selbstbau) oder aus dem Katalog; {@code null}, wenn keine von beiden eine nennt.
     * Das Messstellen-Register (IP-15) nennt den letzten Wert in genau dieser Einheit — es rechnet
     * nie um.
     */
    public String einheit(String pointKey, JsonNode eigeneDefinition) {
        if (eigeneDefinition != null && !eigeneDefinition.isNull()) {
            return text(eigeneDefinition, "unit");
        }
        MeasurementCatalog.Point p = catalog.resolve(pointKey);
        return p == null ? null : p.unit();
    }

    /**
     * Die WIRKSAME Kadenz eines Kanals in Sekunden OHNE eine eingetragene Fassung — die VORGABE:
     * die der Mess-Selektion, sonst die des Katalogs ({@code default_cadence_s}), sonst 300 s
     * (dieselbe Regel wie {@code MeasurementCatalog.Point.view}).
     *
     * <p>Seit UEMS AP-07 IP-10 ist das nur noch das hintere Stück der Kette: vorn steht die
     * zeitgültige Fassung der Quellenbindung. Wer eine hat, ruft {@link #kadenz}.
     */
    public int kadenzS(String pointKey, Integer selektion) {
        return kadenz(pointKey, selektion, null).erwartetS();
    }

    /**
     * Die ganze Vorgabe-Kette (UEMS AP-07 IP-10, Entscheid E9): Fassung der Quellenbindung →
     * Mess-Selektion → Katalog → 300 s, mit der Herkunft der Zahl. {@code fassungS} ist die zum
     * gefragten ZEITPUNKT geltende Fassung ({@code QuelleKadenzService.jeBindung}), {@code null},
     * wenn es keine gibt — dann rechnet diese Methode Zeichen für Zeichen wie vor IP-10.
     */
    public KadenzRegeln.Wirksam kadenz(String pointKey, Integer selektion, Integer fassungS) {
        MeasurementCatalog.Point p = catalog.resolve(pointKey);
        return KadenzRegeln.wirksam(fassungS, selektion, p == null ? null : p.defaultCadenceS());
    }

    /** Die Kadenz, wenn weder Fassung noch Selektion noch Katalog eine nennt. */
    public static final int VORGABE_KADENZ_S = KadenzRegeln.VORGABE_S;

    private static String katalogName(MeasurementCatalog.Point p) {
        return p == null ? null : p.labelDe() == null ? p.labelSource() : p.labelDe();
    }

    /** In der Zeitzone der Messstellen-Schnittstelle (MessstelleService.ZEITZONE). */
    private static OffsetDateTime zeit(Instant t) {
        return t == null ? null : OffsetDateTime.ofInstant(t, MessstelleService.ZEITZONE);
    }

    private JsonNode lesen(String text) {
        try {
            return json.readTree(text);
        } catch (Exception e) {
            return null;
        }
    }

    private static String text(JsonNode n, String feld) {
        JsonNode v = n == null ? null : n.get(feld);
        return v == null || v.isNull() ? null : v.asText();
    }
}
