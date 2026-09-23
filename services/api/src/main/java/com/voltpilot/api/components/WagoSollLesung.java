package com.voltpilot.api.components;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.probe.ProbePublisher;
import com.voltpilot.api.probe.ProbeRequest;
import com.voltpilot.api.probe.ProbeResult;
import com.voltpilot.api.probe.ProbeService;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.ProtokollAkteur;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

/**
 * Das Soll eines WAGO-Registerbilds aus der Steuerung lesen und speichern (AP-05, Folgepaket der
 * Registerbild-Verdrahtung, Entscheid firstmate B vom 23.09.2026).
 *
 * <p>Die Box prüft {@code controller_kennung} und je Karte {@code variante} nur, wenn die Cloud sie
 * kennt; fehlend heißt „nicht geprüft“ (x-registerbilder-rule). Diese Lesung füllt genau diese
 * Lücke — <b>ausschließlich aus dem, was die Steuerung antwortet</b>, nie aus einer Eingabe:
 * <ol>
 *   <li>{@code wago_kopf} (IP-7) über die gemeinsame Verbindung der Energiekarten — nur ein
 *       erkannter v1-Kopf zählt; er liefert Controller-Kennung, Kartenzahl und die Längen.</li>
 *   <li>je Karte n die drei Kennwörter des Karten-Blocks (Steckplatz, Kartentyp, Variante,
 *       Vertrag §4 Offset 0–2) als gewöhnliche u16-Lesungen, höchstens zwei Karten je Anfrage
 *       (acht Schritte je Probe).</li>
 * </ol>
 * Gespeichert wird nur in eine LEERE Stelle. Weicht eine Lesung von einem schon gespeicherten Soll
 * ab — oder passt Steckplatz/Kartentyp nicht zur Karte im Bestand —, wird nichts überschrieben:
 * die Abweichung steht in der Antwort und im Journal am Einbau ({@code wago_soll_abweichung}).
 */
@Service
public class WagoSollLesung {
    /** Der Kartentyp im Freitext der Karte („750-494/000-001 (5 A)“) — dieselbe Regel wie der Publisher. */
    static final Pattern TYP = Pattern.compile("750-(494|495)(?!\\d)");
    private static final int KOPF = 12;
    private static final int BLOCK = 42;
    private static final int KARTEN_JE_ANFRAGE = 2;

    public record Eingabe(UUID deviceId) {}
    public record SollKarte(Integer steckplatz, String typ, Integer variante) {}
    public record Soll(Long controllerKennung, List<SollKarte> karten) {}
    /** {@code feld}: controller_kennung · kartenzahl · steckplatz · kartentyp · variante. */
    public record Abweichung(String feld, Integer steckplatz, Long soll, Long gelesen) {}
    /** {@code ergebnis}: gespeichert · unveraendert · abweichung · nicht_gelesen. */
    public record Ergebnis(String ergebnis, String satz, Soll soll, List<Abweichung> abweichungen) {}

    record Teil(UUID id, Integer steckplatz, String typ, Integer variante) {}
    record Verbindung(String host, int port, int unit, int basis, String registerart, String wortfolge) {}
    /** Die drei Kennwörter von Karte n — {@code null}, wo die Box nicht geantwortet hat. */
    record Kennung(Integer steckplatz, Integer kartentyp, Integer variante) {
        boolean vollstaendig() {
            return steckplatz != null && kartentyp != null && variante != null;
        }
    }

    private final JdbcTemplate jdbc;
    private final ProbeService probes;
    private final DeviceRepository devices;
    private final ObjectMapper mapper;
    private final TransactionTemplate tx;

    public WagoSollLesung(JdbcTemplate jdbc, ProbeService probes, DeviceRepository devices,
            ObjectMapper mapper, PlatformTransactionManager transaktionen) {
        this.jdbc = jdbc;
        this.probes = probes;
        this.devices = devices;
        this.mapper = mapper;
        this.tx = new TransactionTemplate(transaktionen);
    }

    /** Das gespeicherte Soll — für die Antworten dieser Lesung und {@code GET /geraete/{id}/wago}. */
    public Soll soll(UUID geraetId) {
        List<Long> kennungen = jdbc.query("SELECT g.controller_kennung FROM geraet g JOIN site s ON s.id=g.site_id "
                + "WHERE g.id=?", (rs, n) -> (Long) rs.getObject(1), geraetId);
        Long kennung = kennungen.isEmpty() ? null : kennungen.getFirst(); // NULL = nicht gelesen
        List<SollKarte> karten = teile(geraetId).stream()
                .map(t -> new SollKarte(t.steckplatz(), t.typ(), t.variante())).toList();
        return new Soll(kennung, karten);
    }

    public Ergebnis lesen(UUID geraetId, Eingabe in, ProtokollAkteur akteur) {
        String einbau = jdbc.query("SELECT g.einbau_kennzeichen FROM geraet g JOIN site s ON s.id=g.site_id "
                + "WHERE g.id=? AND lower(g.hersteller)='wago'", (rs, n) -> rs.getString(1), geraetId)
                .stream().findFirst().orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "WAGO-Gerät oder Komponente nicht gefunden."));
        if (in == null || in.deviceId() == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Welche Box soll die Steuerung lesen?");
        }
        // Die Box im Mandantenzaun (RLS) — dieselbe Auflösung wie der Probe-Kanal, nur VOR der Lesung.
        if (devices.findById(in.deviceId()).isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Box nicht gefunden.");
        }
        List<Teil> teile = teile(geraetId);
        if (teile.isEmpty() || teile.stream().anyMatch(t -> t.steckplatz() == null)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Zuerst die Energiekarten mit ihrem Steckplatz diesem Gerät zuordnen.");
        }
        Verbindung v = verbindung(geraetId).orElseThrow(() -> new ResponseStatusException(HttpStatus.CONFLICT,
                "Die Energiekarten dieses Geräts haben keine gemeinsame Verbindung — das Registerbild "
                        + "lässt sich nicht eindeutig lesen."));

        // 1. Der Kopf. Nur ein erkannter v1-Kopf zählt; alles andere speichert nichts.
        Optional<ProbeResult> kopfAntwort = probes.probeBox(in.deviceId(), new ProbePublisher.WagoKopfOp("kopf",
                v.host(), v.port(), v.unit(), v.registerart(), v.basis(), v.wortfolge()), List.of(), akteur.sub());
        ProbeResult.WagoKopf kopf = kopfAntwort.flatMap(r -> Optional.ofNullable(r.results()))
                .flatMap(l -> l.stream().filter(z -> "kopf".equals(z.id())).findFirst())
                .map(ProbeResult.OpResult::wagoKopf).orElse(null);
        if (kopfAntwort.isEmpty()) {
            return nichtGelesen(geraetId, "Die Box hat nicht geantwortet — es wurde nichts gespeichert.");
        }
        if (kopf == null || !Boolean.TRUE.equals(kopf.erkannt()) || kopf.controllerKennung() == null) {
            return nichtGelesen(geraetId, kopf == null
                    ? "Die Box konnte den Kopf des Registerbilds nicht lesen — es wurde nichts gespeichert."
                    : "Unter der Basisadresse steht kein VoltPilot-Registerbild v1 — es wurde nichts gespeichert.");
        }

        // 2. Je Karte die drei Kennwörter — nur, wenn die Kartenzahl zum Bestand passt.
        List<Kennung> gelesen = new ArrayList<>();
        if (kopf.kartenzahl() != null && kopf.kartenzahl() == teile.size()) {
            int kopflaenge = kopf.kopflaenge() == null ? KOPF : kopf.kopflaenge();
            int block = kopf.kartenblocklaenge() == null ? BLOCK : kopf.kartenblocklaenge();
            for (int von = 0; von < teile.size(); von += KARTEN_JE_ANFRAGE) {
                gelesen.addAll(karten(in.deviceId(), v, kopflaenge, block, von,
                        Math.min(teile.size(), von + KARTEN_JE_ANFRAGE), akteur.sub()));
            }
        }
        return tx.execute(s -> speichern(geraetId, einbau, kopf, teile, gelesen, akteur));
    }

    private List<Kennung> karten(UUID box, Verbindung v, int kopflaenge, int block, int von, int bis,
            String wer) {
        List<ProbeRequest.Op> ops = new ArrayList<>();
        for (int n = von; n < bis; n++) {
            long start = (long) v.basis() + kopflaenge + (long) n * block;
            if (start + 2 > 65_535) break; // ausserhalb des Registerraums: nicht gelesen
            for (int o = 0; o < 3; o++) {
                ops.add(new ProbeRequest.Op("k" + (n + 1) + "-" + o, v.host(), v.port(), v.unit(), v.registerart(),
                        (int) start + o, "u16", v.wortfolge(), null, null));
            }
        }
        Optional<ProbeResult> antwort = ops.isEmpty() ? Optional.empty() : probes.probeBox(box, ops, wer);
        List<Kennung> out = new ArrayList<>();
        for (int n = von; n < bis; n++) {
            int karte = n + 1;
            out.add(new Kennung(wort(antwort, "k" + karte + "-0"), wort(antwort, "k" + karte + "-1"),
                    wort(antwort, "k" + karte + "-2")));
        }
        return out;
    }

    private static Integer wort(Optional<ProbeResult> antwort, String id) {
        return antwort.flatMap(r -> Optional.ofNullable(r.results())).flatMap(l -> l.stream()
                        .filter(z -> id.equals(z.id()) && z.ok() && z.raw() != null).findFirst())
                .map(z -> z.raw()).filter(d -> d >= 0 && d <= 65_535 && d == Math.floor(d))
                .map(Double::intValue).orElse(null);
    }

    private Ergebnis speichern(UUID geraetId, String einbau, ProbeResult.WagoKopf kopf, List<Teil> teile,
            List<Kennung> gelesen, ProtokollAkteur akteur) {
        Soll vorher = soll(geraetId);
        List<Abweichung> abweichungen = new ArrayList<>();
        boolean geschrieben = false;
        boolean vollstaendig = true;

        Long kennung = vorher.controllerKennung();
        if (kennung == null) {
            geschrieben |= jdbc.update("UPDATE geraet SET controller_kennung=? WHERE id=? AND controller_kennung IS NULL",
                    kopf.controllerKennung(), geraetId) == 1;
        } else if (!kennung.equals(kopf.controllerKennung())) {
            abweichungen.add(new Abweichung("controller_kennung", null, kennung, kopf.controllerKennung()));
        }
        if (kopf.kartenzahl() == null || kopf.kartenzahl() != teile.size()) {
            abweichungen.add(new Abweichung("kartenzahl", null, (long) teile.size(),
                    kopf.kartenzahl() == null ? null : (long) kopf.kartenzahl()));
        }
        for (int n = 0; n < gelesen.size(); n++) {
            Teil t = teile.get(n);
            Kennung k = gelesen.get(n);
            if (!k.vollstaendig()) {
                vollstaendig = false;
                continue;
            }
            if (!k.steckplatz().equals(t.steckplatz())) {
                abweichungen.add(new Abweichung("steckplatz", t.steckplatz(), (long) t.steckplatz(),
                        (long) k.steckplatz()));
                continue;
            }
            Integer typSoll = kartentyp(t.typ());
            if ((k.kartentyp() != 494 && k.kartentyp() != 495) || (typSoll != null && !typSoll.equals(k.kartentyp()))) {
                abweichungen.add(new Abweichung("kartentyp", t.steckplatz(),
                        typSoll == null ? null : (long) typSoll, (long) k.kartentyp()));
                continue;
            }
            if (t.typ() == null || t.typ().isBlank()) {
                geschrieben |= jdbc.update("UPDATE geraet_teil SET typ=? WHERE id=? AND (typ IS NULL OR btrim(typ)='')",
                        "750-" + k.kartentyp(), t.id()) == 1;
            }
            if (t.variante() == null) {
                geschrieben |= jdbc.update("UPDATE geraet_teil SET variante=? WHERE id=? AND variante IS NULL",
                        k.variante(), t.id()) == 1;
            } else if (!t.variante().equals(k.variante())) {
                abweichungen.add(new Abweichung("variante", t.steckplatz(), (long) t.variante(),
                        (long) k.variante()));
            }
        }
        Soll nachher = soll(geraetId);
        if (geschrieben) {
            journal(geraetId, "wago_soll_gelesen", json(vorher, einbau, null), json(nachher, einbau, null), akteur);
        }
        if (!abweichungen.isEmpty()) {
            journal(geraetId, "wago_soll_abweichung", json(nachher, einbau, null), json(null, einbau, abweichungen),
                    akteur);
            return new Ergebnis("abweichung", "Die Steuerung meldet einen anderen Aufbau als gespeichert — "
                    + "das gespeicherte Soll wurde nicht überschrieben.", nachher, abweichungen);
        }
        if (!vollstaendig) {
            return new Ergebnis(geschrieben ? "gespeichert" : "nicht_gelesen",
                    "Nicht jede Energiekarte hat geantwortet — für sie bleibt das Soll offen.", nachher, List.of());
        }
        return geschrieben
                ? new Ergebnis("gespeichert", "Das Soll wurde aus der Steuerung gelesen und gespeichert.", nachher,
                        List.of())
                : new Ergebnis("unveraendert", "Die Steuerung bestätigt das gespeicherte Soll.", nachher, List.of());
    }

    private Ergebnis nichtGelesen(UUID geraetId, String satz) {
        return new Ergebnis("nicht_gelesen", satz, soll(geraetId), List.of());
    }

    static Integer kartentyp(String typ) {
        Matcher m = TYP.matcher(typ == null ? "" : typ);
        return m.find() ? Integer.valueOf(m.group(1)) : null;
    }

    private List<Teil> teile(UUID geraetId) {
        return jdbc.query("SELECT t.id, t.steckplatz, t.typ, t.variante FROM geraet_teil t "
                + "JOIN geraet g ON g.id=t.geraet_id AND g.tenant_id=t.tenant_id JOIN site s ON s.id=g.site_id "
                + "WHERE t.geraet_id=? AND t.teilart='energiekarte' AND t.eingebaut_am<=now() "
                + "AND (t.ausgebaut_am IS NULL OR t.ausgebaut_am>now()) ORDER BY t.steckplatz NULLS LAST, t.id",
                (rs, n) -> new Teil((UUID) rs.getObject(1), (Integer) rs.getObject(2), rs.getString(3),
                        (Integer) rs.getObject(4)), geraetId);
    }

    /** Die EINE Verbindung, über die alle heute zugeordneten Karten-Komponenten gelesen werden. */
    private Optional<Verbindung> verbindung(UUID geraetId) {
        List<String> zeilen = jdbc.query("SELECT m.connection_json::text FROM geraet_komponente k "
                + "JOIN geraet g ON g.id=k.geraet_id AND g.tenant_id=k.tenant_id JOIN site s ON s.id=g.site_id "
                + "JOIN geraet_teil t ON t.id=k.teil_id AND t.tenant_id=k.tenant_id "
                + "JOIN measurement_point m ON m.id=k.entity_id AND m.site_id=g.site_id "
                + "WHERE k.geraet_id=? AND k.gueltig_ab<=now() AND (k.gueltig_bis IS NULL OR k.gueltig_bis>now()) "
                + "AND t.eingebaut_am<=now() AND (t.ausgebaut_am IS NULL OR t.ausgebaut_am>now())",
                (rs, n) -> rs.getString(1), geraetId);
        Set<Verbindung> alle = new LinkedHashSet<>();
        for (String z : zeilen) {
            Verbindung v = verbindung(z, mapper);
            if (v == null) return Optional.empty();
            alle.add(v);
        }
        return alle.size() == 1 ? Optional.of(alle.iterator().next()) : Optional.empty();
    }

    static Verbindung verbindung(String json, ObjectMapper mapper) {
        if (json == null) return null;
        try {
            JsonNode c = mapper.readTree(json);
            String host = c.path("ip").asText("").trim();
            Integer port = ganz(c.get("port"));
            Integer unit = ganz(c.get("mb_slave_id"));
            Integer basis = ganz(c.get("base_address"));
            Integer fc = ganz(c.get("function_code"));
            String wortfolge = c.path("word_order").asText("");
            if (host.isEmpty() || port == null || port < 1 || port > 65_535 || unit == null || unit > 255
                    || basis == null || basis > 65_535 || fc == null || (fc != 3 && fc != 4)
                    || !(wortfolge.equals("big") || wortfolge.equals("little"))) {
                return null;
            }
            return new Verbindung(host, port, unit, basis, fc == 4 ? "input" : "holding", wortfolge);
        } catch (Exception e) {
            return null;
        }
    }

    /** Eine ganze Zahl — auch als Text, wie das Auswahlfeld der Vorlage sie speichert („3“). */
    private static Integer ganz(JsonNode n) {
        if (n == null || n.isNull()) return null;
        if (n.isIntegralNumber()) return n.intValue();
        if (n.isTextual() && n.asText().matches("\\d{1,5}")) return Integer.valueOf(n.asText());
        return null;
    }

    private String json(Soll soll, String einbau, List<Abweichung> abweichungen) {
        ObjectNode o = mapper.createObjectNode().put("einbau", einbau);
        if (soll != null) {
            o.put("controller_kennung", soll.controllerKennung());
            ArrayNode karten = o.putArray("karten");
            for (SollKarte k : soll.karten()) {
                karten.addObject().put("steckplatz", k.steckplatz()).put("typ", k.typ()).put("variante", k.variante());
            }
        }
        if (abweichungen != null) {
            ArrayNode a = o.putArray("abweichungen");
            for (Abweichung x : abweichungen) {
                a.addObject().put("feld", x.feld()).put("steckplatz", x.steckplatz()).put("soll", x.soll())
                        .put("gelesen", x.gelesen());
            }
        }
        return o.toString();
    }

    private void journal(UUID geraetId, String art, String alt, String neu, ProtokollAkteur a) {
        jdbc.update("INSERT INTO geraet_aenderung (tenant_id, geraet_id, art, alt, neu, actor_sub, actor_name, "
                + "actor_rolle, actor_art) VALUES (?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?, ?)",
                TenantContext.get(), geraetId, art, alt, neu, a.sub(), a.name(), a.rolle(), a.art());
    }
}
