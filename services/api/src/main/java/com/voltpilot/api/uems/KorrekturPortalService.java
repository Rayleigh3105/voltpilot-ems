package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.MessreiheKorrekturRepository.Korrektur;
import com.voltpilot.api.uems.MessreiheErsatzwertRepository.Anlage;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/** AP-08 IP-16: lesende Prüfseite und begründete, append-only Entscheidungen im Standort-Zaun. */
@Service
@Transactional
public class KorrekturPortalService {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final JdbcTemplate jdbc;
    private final MessreiheKorrekturRepository korrekturen;
    private final MessreiheErsatzwertRepository ersatzwerte;
    private final MessstelleRepository messstellen;
    private final MessstelleQuelleRepository quellen;
    private final ErsatzwertLauf lauf;
    private final Geltungsbereich geltung;
    private final RechtPruefung rechte;
    private final KorrekturPortalAuswirkungen auswirkungen;
    private java.time.Clock uhr = java.time.Clock.systemUTC();

    void uhrStellen(java.time.Clock uhr) { this.uhr = uhr; }

    public KorrekturPortalService(JdbcTemplate jdbc, MessreiheKorrekturRepository korrekturen,
            MessreiheErsatzwertRepository ersatzwerte, MessstelleRepository messstellen,
            MessstelleQuelleRepository quellen, ErsatzwertLauf lauf, Geltungsbereich geltung, RechtPruefung rechte, KorrekturPortalAuswirkungen auswirkungen) {
        this.jdbc = jdbc; this.korrekturen = korrekturen; this.ersatzwerte = ersatzwerte;
        this.messstellen = messstellen; this.quellen = quellen; this.lauf = lauf; this.geltung = geltung; this.rechte = rechte; this.auswirkungen = auswirkungen;
    }

    public record Eingabe(UUID quelle_id, String methode, Instant von, Instant bis, String begruendung, String beleg,
            UUID luecke_ereignis_id, Instant vorperiode_von, UUID vergleich_quelle_id, Instant zeitpunkt,
            BigDecimal endstand, BigDecimal anfangsstand, BigDecimal betrag, String einheit) {}
    public record Messstelle(String kennzeichen, String name) {}
    public record Urheber(String name, String rolle, String art) {}
    public record Aktion(boolean erlaubt, String grund) {}
    public record Auswirkungen(List<String> perioden, String berechnete_messstellen, String kennzahlen, String berichte) {}
    public record Detail(String kennung, String art, String status, int fassung, Instant von, Instant bis,
            String begruendung, String beleg, String ersatzwert_kennung, String methode, String einheit, List<Messstelle> messstellen, Urheber ersteller,
            Instant erstellt_am, boolean vieraugen, JsonNode vorschau, Auswirkungen auswirkungen,
            Aktion freigeben, Aktion zuruecknehmen, Aktion ablehnen) {}
    public record Vorschau(JsonNode perioden, Auswirkungen auswirkungen, boolean vieraugen, boolean freigabe_noetig) {}
    private record Ort(UUID id, String name, ZoneId zone) {}
    private record Vorbereitet(Anlage anlage, Ort ort) {}

    public record Luecke(UUID id, String art, Instant von, Instant bis, BigDecimal zuwachs, String einheit) {}

    public List<Luecke> luecken(String kennzeichen, UUID quelle, Instant von, Instant bis) {
        if (von == null || bis == null || !von.isBefore(bis) || bis.isAfter(von.plusSeconds(366L * 86400))) throw ungueltig();
        var m = messstellen.findeNachKennzeichen(kennzeichen).orElseThrow(KorrekturPortalService::nichtGefunden);
        var q = quellen.eine(m.id(), quelle).orElseThrow(KorrekturPortalService::nichtGefunden);
        geltung.requireSite(q.siteId());
        geltung.requireStandort(ort(q.entityId(), von).id());
        return jdbc.query("SELECT ereignis_id, art, coalesce(von, zeit), bis, nutzlast->>'zuwachs', nutzlast->>'einheit' "
                + "FROM (SELECT e.*, row_number() OVER (PARTITION BY ereignis_id ORDER BY eingang DESC) AS rang "
                + "FROM messreihe_ereignis e WHERE tenant_id = ? AND entity_id = ? AND messkanal = ? "
                + "AND art IN ('data_gap', 'counter_reset', 'device_boundary')) e WHERE rang = 1 "
                + "AND coalesce(von, zeit) < ? AND (CASE WHEN art = 'data_gap' THEN bis IS NULL OR bis > ? ELSE zeit >= ? END) "
                + "ORDER BY coalesce(von, zeit)", (rs, n) -> new Luecke(rs.getObject(1, UUID.class), rs.getString(2),
                        rs.getTimestamp(3).toInstant(), rs.getTimestamp(4) == null ? null : rs.getTimestamp(4).toInstant(),
                        rs.getString(5) == null ? null : new BigDecimal(rs.getString(5)), rs.getString(6)),
                tenant(), q.entityId(), q.kanal(), Timestamp.from(bis), Timestamp.from(von), Timestamp.from(von));
    }

    public List<Detail> liste(UUID standort, ProtokollAkteur wer) {
        geltung.requireStandort(standort);
        List<Detail> out = new ArrayList<>();
        for (String kennung : jdbc.queryForList("SELECT kennung FROM messreihe_korrektur WHERE tenant_id = ? "
                + "AND fassung = 1 ORDER BY created_at DESC, kennung DESC", String.class, tenant())) {
            Korrektur k = korrekturen.lies(tenant(), kennung).orElseThrow();
            List<Ort> orte = orte(k, false);
            if (!orte.isEmpty() && orte.stream().allMatch(o -> geltung.standortVisible(o.id()))
                    && orte.stream().anyMatch(o -> o.id().equals(standort))) out.add(detail(k, wer, orte));
        }
        return List.copyOf(out);
    }

    public Detail detail(String kennung, ProtokollAkteur wer) {
        Korrektur k = korrekturen.lies(tenant(), kennung).orElseThrow(KorrekturPortalService::nichtGefunden);
        return detail(k, wer, orte(k, true));
    }

    private Detail detail(Korrektur k, ProtokollAkteur wer, List<Ort> orte) {
        boolean vier = vierAugen();
        String ew = k.anlage().ersatzwertKennung();
        String methode = ew == null ? null : ersatzwerte.lies(tenant(), ew).orElseThrow().anlage().methode();
        Aktion frei = aktion(k, wer, KorrekturRechte.KORREKTUR_FREIGEBEN, vier, orte, "vorschlag");
        Aktion rueck = aktion(k, wer, KorrekturRechte.KORREKTUR_ZURUECKNEHMEN, vier, orte, "freigegeben");
        return new Detail(k.kennung(), k.anlage().art(), k.status(), k.fassungen().size(), k.anlage().von(), k.anlage().bis(),
                k.anlage().begruendung(), k.anlage().beleg(), ew, methode, einheit(k), messstellen(k),
                new Urheber(k.ersteller().name(), k.ersteller().rolle(), k.ersteller().art()), k.fassungen().get(0).am(),
                vier, vorschauForm(k), auswirkungen.lesen(k.anlage().reihen(), k.anlage().von(), k.anlage().bis(), orte.get(0).zone(), wer), frei, rueck,
                // Ablehnen ist ebenfalls eine Entscheidung durch den zuständigen Prüfer.
                frei);
    }

    private List<Messstelle> messstellen(Korrektur k) {
        List<Messstelle> aus = new ArrayList<>();
        for (var r : k.anlage().reihen()) {
            if (r.messstelleId() != null) {
                var m = messstellen.finde(r.messstelleId()).orElseThrow(KorrekturPortalService::nichtGefunden);
                aus.add(new Messstelle(m.kennzeichen(), m.name()));
                continue;
            }
            aus.addAll(jdbc.query("SELECT m.kennzeichen, m.name FROM messstelle_quelle q "
                + "JOIN messstelle m ON m.id = q.messstelle_id WHERE q.tenant_id = ? AND q.entity_id = ? AND q.kanal = ? "
                + "AND q.rolle = 'fuehrend' AND q.gueltig_ab < ? AND (q.gueltig_bis IS NULL OR q.gueltig_bis > ?)",
                (rs, n) -> new Messstelle(rs.getString(1), rs.getString(2)), tenant(), r.entityId(), r.messkanal(),
                Timestamp.from(k.anlage().bis()), Timestamp.from(k.anlage().von())));
        }
        return aus.stream().distinct().toList();
    }

    private String einheit(Korrektur k) {
        var r = k.anlage().reihen().get(0);
        return r.messstelleId() == null ? lauf.einheit(r.messkanal())
                : messstellen.finde(r.messstelleId()).orElseThrow(KorrekturPortalService::nichtGefunden).hauptgroesse().einheit();
    }

    private static JsonNode vorschauForm(Korrektur k) {
        var aus = k.anlage().vorschau().deepCopy();
        for (JsonNode p : aus) {
            if (!p.isObject() || p.has("version_alt")) continue;
            if ("ablesung".equals(p.path("spur").asText())) {
                var zeile = (com.fasterxml.jackson.databind.node.ObjectNode) p;
                zeile.put("periode", "ablesung").put("von", p.path("zeitpunkt").asText()).put("bis", p.path("zeitpunkt").asText());
                int vorher = p.path("alt").path("fassung").asInt(0);
                zeile.put("version_alt", vorher).put("version_neu", p.path("neu").path("fassung").asInt(vorher + 1));
                for (String seite : List.of("alt", "neu")) {
                    JsonNode stand = p.path(seite);
                    var n = JSON.createObjectNode().put("menge_zustand", stand.isNull() ? "keine Werte" : "abgelesen");
                    if (stand.isNull()) n.putNull("menge"); else n.put("menge", new BigDecimal(stand.path("stand").asText()));
                    zeile.set(seite, n);
                }
                continue;
            }
            int alt = p.path("alt").path("version").asInt(1);
            ((com.fasterxml.jackson.databind.node.ObjectNode) p).put("version_alt", alt).put("version_neu", alt + 1);
        }
        return aus;
    }

    private Aktion aktion(Korrektur k, ProtokollAkteur wer, String recht, boolean vier, List<Ort> orte, String status) {
        if (!status.equals(k.status())) return new Aktion(false, "status_passt_nicht");
        for (Ort ort : orte) {
            var d = k.anlage().reihen().get(0).messstelleId() == null
                    ? urteil(k.ersteller().sub(), wer, recht, vier, ort)
                    : KorrekturRechte.entscheiden(wer, recht, k.ersteller().sub(), vier, Instant.now());
            if (!d.darf()) return new Aktion(false, d.grund().name().toLowerCase(java.util.Locale.ROOT));
        }
        return new Aktion(true, null);
    }

    private RechteAbleitung.DarfErgebnis urteil(String ersteller, ProtokollAkteur wer, String recht, boolean vier, Ort ort) {
        var bereich = new RechteAbleitung.Kundenbereich("Kundenbereich",
                List.of(new RechteAbleitung.Standort(ort.id().toString(), ort.name())), List.of());
        return RechteAbleitung.korrekturEntscheiden(KorrekturRechte.MATRIX, KorrekturRechte.aufrufer(wer), bereich,
                recht, RechteAbleitung.Ziel.standort(ort.id().toString()), Instant.now(), ersteller, vier);
    }

    /** Bestehende Entscheidungsroute: jeder betroffene Standort, danach Vier-Augen-Regel am selben Ziel. */
    public void entscheidungPruefen(Korrektur k, ProtokollAkteur wer, String recht, boolean vier) {
        for (Ort ort : orte(k, true)) {
            if (k.anlage().reihen().get(0).messstelleId() != null) {
                var d = KorrekturRechte.entscheiden(wer, recht, k.ersteller().sub(), vier, Instant.now());
                if (!d.darf()) throw KorrekturFreigabeAbgelehnt.rechte(d);
                continue;
            }
            rechte.pruefen(recht, RechtZiel.STANDORT, ort.id(), KorrekturPortalService::nichtGefunden);
            var d = urteil(k.ersteller().sub(), wer, recht, vier, ort);
            if (!d.darf()) throw KorrekturFreigabeAbgelehnt.rechte(d);
        }
    }

    /** Unter derselben Reihensperre wie der Job: ein inzwischen geänderter Plan braucht eine neue Prüfung. */
    public void freigabePruefen(Korrektur k) {
        if (k.anlage().ersatzwertKennung() == null) return;
        var ew = ersatzwerte.lies(tenant(), k.anlage().ersatzwertKennung()).orElseThrow(KorrekturPortalService::nichtGefunden);
        sperren(ew.anlage());
        var neu = planen(ew.anlage(), ew.kennung());
        try {
            // jsonb liest Ganzzahlen/Dezimalzahlen neu; JsonNode-Typen selbst sind kein fachlicher Unterschied.
            if (!JSON.readTree(neu.perioden().toString()).equals(k.anlage().vorschau()))
                throw new ResponseStatusException(HttpStatus.CONFLICT, "Die Werte haben sich seit der Vorschau geändert.");
        } catch (com.fasterxml.jackson.core.JsonProcessingException x) { throw new IllegalStateException(x); }
    }

    private void sperren(Anlage a) {
        jdbc.queryForList("SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(?, 0))", Integer.class,
                "uems-ersatzwert:" + tenant() + ":" + a.entityId() + ":" + a.messkanal());
    }

    public Vorschau vorschau(String kennzeichen, Eingabe eingabe, ProtokollAkteur wer) {
        Vorbereitet v = vorbereiten(kennzeichen, eingabe);
        var p = planen(v.anlage(), "EW-9999-999999999");
        boolean vier = vierAugen();
        return new Vorschau(p.perioden(), auswirkungen.lesen(List.of(new MessreiheKorrekturRepository.Reihe(v.anlage().entityId(), v.anlage().messkanal())),
                v.anlage().von(), v.anlage().bis(), v.ort().zone(), wer), vier, vier || endgueltigeAblesung(v.anlage()));
    }

    public Detail erfassen(String kennzeichen, Eingabe eingabe, ProtokollAkteur wer) {
        Vorbereitet v = vorbereiten(kennzeichen, eingabe);
        rechte.pruefen(KorrekturRechte.ERSATZWERT_ERFASSEN, RechtZiel.STANDORT, v.ort().id(), KorrekturPortalService::nichtGefunden);
        // Gleiche Matrix auch ohne Zugriff-Kontext (Alt-Kunden und Plattform-Umschalter).
        var d = RechteAbleitung.darf(KorrekturRechte.MATRIX, KorrekturRechte.aufrufer(wer),
                new RechteAbleitung.Kundenbereich("Kundenbereich", List.of(new RechteAbleitung.Standort(v.ort().id().toString(), v.ort().name())), List.of()),
                KorrekturRechte.ERSATZWERT_ERFASSEN, RechteAbleitung.Ziel.standort(v.ort().id().toString()), Instant.now());
        if (!d.darf()) throw KorrekturFreigabeAbgelehnt.rechte(d);
        boolean vier = vierAugen();
        sperren(v.anlage());
        planen(v.anlage(), "EW-9999-999999999");
        var ew = ersatzwerte.erfassen(tenant(), v.anlage(), wer, v.ort().zone());
        var p = planen(v.anlage(), ew.kennung());
        // Kernschreibweg: Ersatzwert und Vorschlag sind eine atomare Einheit; kein Wert wird hier verändert.
        var k = korrekturen.vorschlagen(tenant(), new MessreiheKorrekturRepository.Anlage("ersatzwert",
                List.of(new MessreiheKorrekturRepository.Reihe(v.anlage().entityId(), v.anlage().messkanal())),
                v.anlage().von(), v.anlage().bis(), v.anlage().begruendung(), v.anlage().beleg(), ew.kennung(), p.perioden()), wer, v.ort().zone());
        if (!vier && !endgueltigeAblesung(v.anlage())) k = korrekturen.freigeben(tenant(), k.kennung(), eingabe.begruendung(), wer, false);
        return detail(k, wer, List.of(v.ort()));
    }

    /** F12: ein nachgetragener Stand nach Endgültigkeit bleibt auch ohne zweite Person ein Vorschlag. */
    private boolean endgueltigeAblesung(Anlage a) {
        return VerbrauchRegeln.ABLESESTAND_NACHTRAGEN.equals(a.methode()) && Boolean.TRUE.equals(jdbc.queryForObject(
                "SELECT EXISTS (SELECT 1 FROM messreihe_viertelstunde WHERE tenant_id = ? AND entity_id = ? "
                + "AND messkanal = ? AND intervall_beginn >= ? AND intervall_beginn < ? AND endgueltig_ab <= ?)",
                Boolean.class, tenant(), a.entityId(), a.messkanal(), Timestamp.from(a.von()), Timestamp.from(a.bis()),
                Timestamp.from(uhr.instant())));
    }

    public Detail ablehnen(String kennung, String grund, ProtokollAkteur wer) {
        text(grund);
        Korrektur k = korrekturen.lies(tenant(), kennung).orElseThrow(KorrekturPortalService::nichtGefunden);
        entscheidungPruefen(k, wer, KorrekturRechte.KORREKTUR_FREIGEBEN, vierAugen());
        if (!"vorschlag".equals(k.status())) throw konflikt();
        korrekturen.ablehnen(tenant(), kennung, grund, wer);
        if (k.anlage().ersatzwertKennung() != null) ersatzwerte.zuruecknehmen(tenant(), k.anlage().ersatzwertKennung(), grund, wer);
        return detail(kennung, wer);
    }

    /** Die Ersatzwert-Route und die bestehende Korrektur-Rücknahme schreiben dieselben beiden Fassungen. */
    public record ErsatzwertStand(String kennung, String status, int fassung, String korrektur) {}

    public ErsatzwertStand ersatzwertZuruecknehmen(String kennung, String grund, ProtokollAkteur wer) {
        var ew = ersatzwerte.lies(tenant(), kennung).orElseThrow(KorrekturPortalService::nichtGefunden);
        List<String> ks = jdbc.queryForList("SELECT kennung FROM messreihe_korrektur WHERE tenant_id = ? "
                + "AND fassung = 1 AND ersatzwert_kennung = ?", String.class, tenant(), kennung);
        if (ks.isEmpty()) {
            // Bestand vor den Portal-Routen: Ersatzwerte ohne verknüpfte Korrektur bleiben widerrufbar.
            Ort ort = ort(ew.anlage().entityId(), ew.anlage().von());
            geltung.requireStandort(ort.id());
            rechte.pruefen(KorrekturRechte.KORREKTUR_ZURUECKNEHMEN, RechtZiel.STANDORT, ort.id(), KorrekturPortalService::nichtGefunden);
            var d = urteil(ew.erfasser().sub(), wer, KorrekturRechte.KORREKTUR_ZURUECKNEHMEN, vierAugen(), ort);
            if (!d.darf()) throw KorrekturFreigabeAbgelehnt.rechte(d);
            text(grund);
            if (!"wirksam".equals(ew.status())) throw konflikt();
            var neu = ersatzwerte.zuruecknehmen(tenant(), kennung, grund, wer);
            return new ErsatzwertStand(kennung, neu.status(), neu.fassungen().size(), null);
        }
        if (ks.size() != 1) throw konflikt();
        Korrektur k = korrekturen.lies(tenant(), ks.get(0)).orElseThrow();
        entscheidungPruefen(k, wer, KorrekturRechte.KORREKTUR_ZURUECKNEHMEN, vierAugen());
        text(grund);
        if (!"freigegeben".equals(k.status()) || !"wirksam".equals(ew.status())) throw konflikt();
        korrekturen.zuruecknehmen(tenant(), k.kennung(), grund, wer);
        ersatzwertRuecknahme(k, grund, wer);
        var neu = ersatzwerte.lies(tenant(), kennung).orElseThrow();
        return new ErsatzwertStand(kennung, neu.status(), neu.fassungen().size(), k.kennung());
    }

    public void ersatzwertRuecknahme(Korrektur k, String grund, ProtokollAkteur wer) {
        if (k.anlage().ersatzwertKennung() == null) return;
        // Zusatzschreibweg am bestehenden Korrektur-Dienst: Fehler hinterlassen keine abgebrochene DB-Transaktion.
        jdbc.execute((ConnectionCallback<Void>) con -> {
            var savepoint = con.setSavepoint();
            try {
                ersatzwerte.zuruecknehmen(tenant(), k.anlage().ersatzwertKennung(), grund, wer);
            } catch (RuntimeException x) {
                con.rollback(savepoint);
                throw x;
            } finally { con.releaseSavepoint(savepoint); }
            return null;
        });
    }

    private ErsatzwertLauf.Vorschau planen(Anlage a, String kennung) {
        var p = jdbc.execute((ConnectionCallback<ErsatzwertLauf.Vorschau>) con -> lauf.vorschau(con, tenant(), kennung, a));
        if (p.ablehnung() != null) throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, p.ablehnung());
        if (p.perioden().isEmpty()) throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, "Keine Änderung im Zeitraum.");
        return p;
    }

    private Vorbereitet vorbereiten(String kennzeichen, Eingabe e) {
        if (e == null || e.quelle_id() == null || e.methode() == null || !ErgebnisZustand.ERSATZWERT_METHODE_NAME.containsKey(e.methode())
                || e.von() == null || e.bis() == null || !e.von().isBefore(e.bis())
                || e.von().getNano() != 0 || e.bis().getNano() != 0 || e.von().getEpochSecond() % 900 != 0
                || e.bis().getEpochSecond() % 900 != 0) throw ungueltig();
        var m = messstellen.findeNachKennzeichen(kennzeichen).orElseThrow(KorrekturPortalService::nichtGefunden);
        var q = quellen.eine(m.id(), e.quelle_id()).orElseThrow(KorrekturPortalService::nichtGefunden);
        if (!"fuehrend".equals(q.rolle()) || q.gueltigAb().isAfter(e.von()) || q.gueltigBis() != null && q.gueltigBis().isBefore(e.bis())) throw ungueltig();
        Ort ort = ort(q.entityId(), e.von());
        geltung.requireStandort(ort.id());
        if (VerbrauchRegeln.WERT_EINGEBEN.equals(e.methode())
                && e.bis().isAfter(e.von().atZone(ort.zone()).plusMonths(1).toInstant())) throw ungueltig();
        text(e.begruendung());
        if (e.beleg() != null) text(e.beleg());
        boolean verteilen = VerbrauchRegeln.VERTEILEN.contains(e.methode());
        boolean vorher = List.of(VerbrauchRegeln.PROFIL_VORPERIODE, VerbrauchRegeln.VORPERIODE_UEBERNEHMEN).contains(e.methode());
        boolean vergleich = List.of(VerbrauchRegeln.PROFIL_VERGLEICHSQUELLE, VerbrauchRegeln.VERGLEICHSQUELLE_UEBERNEHMEN).contains(e.methode());
        boolean ablesung = VerbrauchRegeln.ABLESESTAND_NACHTRAGEN.equals(e.methode());
        boolean betrag = VerbrauchRegeln.WERT_EINGEBEN.equals(e.methode());
        if (verteilen != (e.luecke_ereignis_id() != null) || vergleich != (e.vergleich_quelle_id() != null)
                || betrag != (e.betrag() != null) || ablesung != (e.endstand() != null || e.anfangsstand() != null)
                || ablesung != (e.zeitpunkt() != null) || betrag && e.beleg() == null
                || !vorher && e.vorperiode_von() != null) throw ungueltig();
        if (ablesung && (e.zeitpunkt().getNano() != 0 || e.zeitpunkt().getEpochSecond() % 60 != 0
                || !e.zeitpunkt().isAfter(e.von()) || e.zeitpunkt().isAfter(e.bis())
                || !e.bis().equals(e.von().plusSeconds(900)))) throw ungueltig();
        Instant vor = vorher ? (e.vorperiode_von() == null ? e.von().atZone(ort.zone()).minusDays(7).toInstant() : e.vorperiode_von()) : null;
        if (vor != null && (!vor.isBefore(e.von()) || vor.getEpochSecond() % 900 != 0 || vor.getNano() != 0)) throw ungueltig();
        if (vergleich) {
            var v = quellen.eine(m.id(), e.vergleich_quelle_id()).orElseThrow(KorrekturPortalService::nichtGefunden);
            if (!"vergleich".equals(v.rolle()) || !q.groesse().equals(v.groesse()) || v.gueltigAb().isAfter(e.von())
                    || v.gueltigBis() != null && v.gueltigBis().isBefore(e.bis())) throw ungueltig();
            geltung.requireSite(v.siteId());
        }
        BigDecimal zuwachs = null, standVor = null, standNach = null;
        String einheit = e.einheit();
        if (verteilen) {
            var luecken = jdbc.queryForList("SELECT nutzlast->>'zuwachs' AS zuwachs, nutzlast->>'stand_vor' AS stand_vor, "
                    + "nutzlast->>'stand_nach' AS stand_nach, nutzlast->>'einheit' AS einheit FROM messreihe_ereignis "
                    + "WHERE tenant_id = ? AND ereignis_id = ? AND entity_id = ? AND messkanal = ? AND art = 'data_gap' "
                    + "AND nutzlast->>'zuwachs' IS NOT NULL ORDER BY eingang DESC LIMIT 1", tenant(), e.luecke_ereignis_id(), q.entityId(), q.kanal());
            if (luecken.isEmpty()) throw ungueltig();
            var l = luecken.get(0);
            zuwachs = new BigDecimal((String) l.get("zuwachs")); standVor = new BigDecimal((String) l.get("stand_vor"));
            standNach = new BigDecimal((String) l.get("stand_nach")); einheit = (String) l.get("einheit");
        } else if (!ablesung && Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM messreihe_ereignis "
                + "WHERE tenant_id = ? AND entity_id = ? AND messkanal = ? AND art = 'data_gap' "
                + "AND von < ? AND bis > ? AND nutzlast->>'zuwachs' IS NOT NULL)", Boolean.class,
                tenant(), q.entityId(), q.kanal(), Timestamp.from(e.bis()), Timestamp.from(e.von())))) throw ungueltig();
        if (!verteilen && !ablesung && Boolean.TRUE.equals(jdbc.queryForObject(
                "SELECT count(*) = ? AND coalesce(bool_and(abdeckung_prozent = 100), false) "
                + "FROM messreihe_viertelstunde WHERE tenant_id = ? AND entity_id = ? AND messkanal = ? "
                + "AND intervall_beginn >= ? AND intervall_beginn < ?", Boolean.class,
                java.time.Duration.between(e.von(), e.bis()).getSeconds() / 900, tenant(), q.entityId(), q.kanal(),
                Timestamp.from(e.von()), Timestamp.from(e.bis()))))
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "In diesem Zeitraum sind alle Werte gemessen – ein Ersatzwert ist nicht möglich.");
        if ((verteilen || betrag || ablesung) != (einheit != null && !einheit.isBlank())) throw ungueltig();
        return new Vorbereitet(new Anlage(e.methode(), q.entityId(), q.kanal(), m.id(), e.von(), e.bis(), e.zeitpunkt(),
                e.begruendung(), e.beleg(), e.luecke_ereignis_id(), zuwachs, standVor, standNach, einheit, vor,
                e.vergleich_quelle_id(), e.endstand(), e.anfangsstand(), e.betrag()), ort);
    }

    private List<Ort> orte(Korrektur k, boolean pflicht) {
        List<Ort> out = new ArrayList<>();
        for (var r : k.anlage().reihen()) {
            try { out.add(r.messstelleId() == null ? ort(r.entityId(), k.anlage().von()) : ableseOrt(r.messstelleId())); }
            catch (ResponseStatusException x) { if (pflicht) throw x; return List.of(); }
        }
        if (pflicht) { if (out.isEmpty()) throw nichtGefunden(); out.forEach(o -> geltung.requireStandort(o.id())); }
        return out.stream().distinct().toList();
    }

    private Ort ableseOrt(UUID messstelle) {
        // Tageszuordnung der Messstelle einschließlich Gebäude/Bereich; der bestehende Ableseweg bleibt zuständig.
        var orte = jdbc.query("SELECT st.id, st.name, st.zeitzone FROM messstelle m "
                + "JOIN messstelle_ort mo ON mo.messstelle_id = m.id AND mo.aufgehoben_am IS NULL "
                + "AND daterange(mo.gueltig_ab, mo.gueltig_bis, '[]') @> uems_zugriff_heute(m.tenant_id) "
                + "LEFT JOIN ort_zuordnung z ON z.ort_id = mo.ort_id AND z.aufgehoben_am IS NULL "
                + "AND daterange(z.gueltig_ab, z.gueltig_bis, '[]') @> uems_zugriff_heute(m.tenant_id) "
                + "LEFT JOIN ort_zuordnung g ON g.ort_id = z.eltern_ort_id AND g.aufgehoben_am IS NULL "
                + "AND daterange(g.gueltig_ab, g.gueltig_bis, '[]') @> uems_zugriff_heute(m.tenant_id) "
                + "JOIN standort st ON st.id = coalesce(mo.standort_id, z.eltern_standort_id, g.eltern_standort_id) "
                + "WHERE m.tenant_id = ? AND m.id = ?", (rs, n) -> new Ort(rs.getObject(1, UUID.class),
                        rs.getString(2), ZoneId.of(rs.getString(3))), tenant(), messstelle);
        return orte.stream().findFirst().orElseThrow(KorrekturPortalService::nichtGefunden);
    }

    private Ort ort(UUID entity, Instant von) {
        var orte = jdbc.query("SELECT st.id, st.name, st.zeitzone FROM measurement_point p "
                + "JOIN site s ON s.id = p.site_id JOIN anlage_standort a ON a.site_id = s.id AND a.tenant_id = p.tenant_id "
                + "JOIN standort st ON st.id = a.standort_id WHERE p.tenant_id = ? AND p.id = ? AND a.aufgehoben_am IS NULL "
                + "AND a.gueltig_ab <= (?::timestamptz AT TIME ZONE st.zeitzone)::date "
                + "AND (a.gueltig_bis IS NULL OR a.gueltig_bis >= (?::timestamptz AT TIME ZONE st.zeitzone)::date) "
                + "ORDER BY a.gueltig_ab DESC LIMIT 1", (rs, n) -> new Ort(rs.getObject(1, UUID.class), rs.getString(2), ZoneId.of(rs.getString(3))),
                tenant(), entity, Timestamp.from(von), Timestamp.from(von));
        return orte.stream().findFirst().orElseThrow(KorrekturPortalService::nichtGefunden);
    }

    private boolean vierAugen() {
        return jdbc.queryForList("SELECT vieraugen_freigabe FROM unternehmen WHERE tenant_id = ? FOR SHARE", Boolean.class, tenant())
                .stream().anyMatch(Boolean.TRUE::equals);
    }
    private static UUID tenant() { if (TenantContext.get() == null) throw nichtGefunden(); return TenantContext.get(); }
    private static void text(String s) { if (s == null || s.isBlank() || s.codePointCount(0, s.length()) < 10 || s.codePointCount(0, s.length()) > 500) throw ungueltig(); }
    private static ResponseStatusException ungueltig() { return new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, "Eingabe passt nicht zur Ersatzwert-Methode."); }
    private static ResponseStatusException konflikt() { return new ResponseStatusException(HttpStatus.CONFLICT, "Dieser Vorgang ist bereits entschieden."); }
    private static ResponseStatusException nichtGefunden() { return new ResponseStatusException(HttpStatus.NOT_FOUND, "Korrektur nicht gefunden."); }
}
