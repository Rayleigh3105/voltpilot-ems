package com.voltpilot.api.repo;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.profile.AnwendungKatalog.LayoutDoc;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Der gespeicherte WILLE über ein Cockpit-Layout ({@code cockpit_layout},
 * Migration {@code V20260839000000}) — RLS-gefenced wie jede mandantengebundene
 * Tabelle, also über den {@code @Primary}-Datenpfad. Ein Portal-Admin erreicht
 * eine fremde Anlage über den {@code X-Tenant-Id}-Umschalter; es gibt hier
 * keinen BYPASSRLS-Pfad.
 *
 * <p>Die Tabelle ist SCOPE-GENERISCH (Captain-Entscheid E1): {@code scope_kind}
 * trägt {@code site} (das Anlagen-Cockpit) und {@code tenant} (die kunden-weite
 * Vorgabe), {@code surface} ist für {@code portfolio} (Stufe 4) vorbereitet.
 * Diese Klasse kennt deshalb keine der beiden Bedeutungen — sie liest und
 * schreibt Dokumente unter einem Schlüssel.
 *
 * <p>Ein unlesbares Dokument degradiert zum LEEREN Dokument, nie zu einem
 * Fehler: die Fläche fällt dann auf den deterministischen Katalog-Standard
 * zurück, und das ist genau das Verhalten ohne Zeile.
 */
@Repository
public class CockpitLayoutRepository {

    /** Das Anlagen-Cockpit. */
    public static final String SCOPE_SITE = "site";
    /** Die kunden-weite Vorgabe (E1) bzw. — ab Stufe 4 — das Portfolio. */
    public static final String SCOPE_TENANT = "tenant";
    /** Die Fläche „Anlagen-Cockpit". */
    public static final String SURFACE_COCKPIT = "cockpit";
    /** Reserviert für Stufe 4. */
    public static final String SURFACE_PORTFOLIO = "portfolio";
    /** Die Schicht des Betreibers/Admins. */
    public static final String LAYER_VORGABE = "vorgabe";
    /** Die Schicht des Kunden — sie GEWINNT (E2). */
    public static final String LAYER_EIGEN = "eigen";

    /** Eine gespeicherte Schicht samt ihrer Papier-Spur. */
    public record StoredLayout(String scopeKind, UUID scopeId, String surface, String layer,
            LayoutDoc document, String updatedBy, Instant updatedAt) {}

    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;

    public CockpitLayoutRepository(JdbcTemplate jdbc, ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.mapper = mapper;
    }

    /** Alle Schichten eines Schlüssels (0..2 Zeilen), in Katalog-Reihenfolge. */
    public List<StoredLayout> find(String scopeKind, UUID scopeId, String surface) {
        return jdbc.query(
                "SELECT scope_kind, scope_id, surface, layer, document, updated_by, updated_at "
                        + "FROM cockpit_layout WHERE scope_kind = ? AND scope_id = ? "
                        + "AND surface = ? ORDER BY layer",
                (rs, i) -> new StoredLayout(rs.getString("scope_kind"),
                        UUID.fromString(rs.getString("scope_id")), rs.getString("surface"),
                        rs.getString("layer"), parse(rs.getString("document")),
                        rs.getString("updated_by"),
                        rs.getTimestamp("updated_at") == null ? null
                                : rs.getTimestamp("updated_at").toInstant()),
                scopeKind, scopeId, surface);
    }

    /**
     * Schreibt eine Schicht (der Client schickt immer das VOLLSTÄNDIGE
     * Dokument). Die RLS-{@code WITH CHECK} stempelt den Mandanten aus der
     * Sitzung — ein fremder Schlüssel kann damit gar nicht erst geschrieben
     * werden.
     */
    public void save(String scopeKind, UUID scopeId, String surface, String layer,
            LayoutDoc document, String updatedBy) {
        jdbc.update(
                "INSERT INTO cockpit_layout (scope_kind, scope_id, surface, layer, document, "
                        + "tenant_id, updated_by, updated_at) VALUES (?, ?, ?, ?, ?::jsonb, "
                        + "NULLIF(current_setting('app.tenant_id', true), '')::uuid, ?, now()) "
                        + "ON CONFLICT (scope_kind, scope_id, surface, layer) DO UPDATE SET "
                        + "document = EXCLUDED.document, updated_by = EXCLUDED.updated_by, "
                        + "updated_at = now()",
                scopeKind, scopeId, surface, layer, json(document), updatedBy);
    }

    /** Der RESET einer Schicht IST ein Löschen — sie fällt damit auf die darunter. */
    public int delete(String scopeKind, UUID scopeId, String surface, String layer) {
        return jdbc.update(
                "DELETE FROM cockpit_layout WHERE scope_kind = ? AND scope_id = ? "
                        + "AND surface = ? AND layer = ?",
                scopeKind, scopeId, surface, layer);
    }

    /** Räumt jede Schicht einer Anlage ab (der Unclaim-/Löschpfad einer Anlage). */
    public int deleteForScope(String scopeKind, UUID scopeId) {
        return jdbc.update("DELETE FROM cockpit_layout WHERE scope_kind = ? AND scope_id = ?",
                scopeKind, scopeId);
    }

    private LayoutDoc parse(String raw) {
        if (raw == null || raw.isBlank()) {
            return LayoutDoc.leer();
        }
        try {
            JsonNode node = mapper.readTree(raw);
            return new LayoutDoc(strings(node.path("order")), strings(node.path("hidden")),
                    strings(node.path("shown")),
                    node.hasNonNull("lead") ? node.get("lead").asText() : null);
        } catch (Exception e) {
            // Ein unlesbares Dokument ist kein Fehler der Anlage: die Fläche
            // fällt auf den deterministischen Standard zurück.
            return LayoutDoc.leer();
        }
    }

    private static List<String> strings(JsonNode array) {
        List<String> out = new ArrayList<>();
        for (JsonNode n : array) {
            if (n != null && n.isTextual()) {
                out.add(n.asText());
            }
        }
        return List.copyOf(out);
    }

    private String json(LayoutDoc doc) {
        try {
            var node = mapper.createObjectNode();
            node.put("version", 1);
            node.set("order", mapper.valueToTree(doc.order()));
            node.set("hidden", mapper.valueToTree(doc.hidden()));
            node.set("shown", mapper.valueToTree(doc.shown()));
            if (doc.lead() == null) {
                node.putNull("lead");
            } else {
                node.put("lead", doc.lead());
            }
            return mapper.writeValueAsString(node);
        } catch (Exception e) {
            throw new IllegalStateException("cockpit layout could not be serialized", e);
        }
    }
}
