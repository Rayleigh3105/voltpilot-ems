package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.SteuerungsverbundRepository.MitgliedZeile;
import com.voltpilot.api.uems.SteuerungsverbundRepository.VerbundZeile;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Rolle;
import com.voltpilot.api.web.dto.MessstelleWerteDto;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Die Verbund-Bilanz einer Anlage für einen abgeschlossenen Tag rechnen, speichern und ihre Folge ziehen (UEMS AP-15
 * IP-12, A17, B3, B5). Nur eine Anlage MIT Gemeinsamer Steuerung und wirksamen Mitgliedern bekommt ein Ergebnis — der
 * Bestand bleibt ohne Zeile (I6, R22).
 *
 * <p><b>Die Terme</b> sind Viertelstunden von Messstellen, gelesen über {@link MessstelleWerteService} mit Zustand
 * (AP-08, aufgerufen, nie nachgebaut) — die Mess-Welt beweist (§3.3), nie ein Box-Rohwert:
 * <ul>
 *   <li><b>Netzpunkt</b> = die Messstellen an den Komponenten des Messpunkts der führenden Box (B1: der Netzzähler);
 *       an der Übergabe ist das der Hauptzähler als Messstelle.</li>
 *   <li><b>mitsteuernde Box</b> = die Messstellen ihres Messpunkts: ein Abgangszähler, hinter dem alles liegt, was sie
 *       steuert, oder — ohne Abgangszähler — ihre Geräte selbst (B3).</li>
 *   <li><b>führende Box</b> = die Summe ihrer Geräteleistungen: die Messstellen aller Komponenten, die sie außerhalb
 *       ihres Messpunkts liest. Hat eine davon keine Messstelle, ist ihr Beitrag unbekannt — nie Null (B5).</li>
 * </ul>
 * Vorzeichen aus der Richtung der Bindung: Bezug und Laden +, Abgabe, Erzeugung und Entladen −; „Laden / Entladen“
 * und richtungslos tragen kein eindeutiges Vorzeichen und machen den Tag {@code unbekannt}.
 *
 * <p><b>Die Folge</b> ({@link GemeinsameSteuerungService#bilanzUnplausibel}): {@code unplausibel} führt eine Anlage
 * über S1 auf S1 zurück, die Anteile bleiben in Kraft; {@code unbekannt} ändert nichts. Die Bilanz trägt keine
 * Beweislast (E3 = A — die trägt die Sprungprobe vor dem Scharfschalten).
 */
@Service
public class VerbundBilanzService {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Duration VIERTELSTUNDE = Duration.ofMinutes(15);
    private static final Map<String, Integer> VORZEICHEN = Map.of("Bezug", 1, "Laden", 1, "Abgabe", -1,
            "Erzeugung", -1, "Entladen", -1);

    private final SteuerungsverbundRepository verbund;
    private final VerbundBilanzRepository repo;
    private final MessstelleWerteService werte;
    private final GemeinsameSteuerungService steuerung;

    public VerbundBilanzService(SteuerungsverbundRepository verbund, VerbundBilanzRepository repo,
            MessstelleWerteService werte, GemeinsameSteuerungService steuerung) {
        this.verbund = verbund;
        this.repo = repo;
        this.werte = werte;
        this.steuerung = steuerung;
    }

    /** Die Anlagen des Kundenbereichs (RLS) mit Gemeinsamer Steuerung — nur sie rechnet der Lauf. */
    public List<UUID> anlagen() {
        return repo.anlagenMitVerbund();
    }

    /**
     * Rechnet den Tag der Anlage. Leer ohne Gemeinsame Steuerung, ohne wirksame Mitglieder (aufgelöst) oder wenn der
     * Tag schon ein Ergebnis hat — dann schreibt der Lauf nichts.
     */
    @Transactional
    public Optional<VerbundBilanzRepository.Ergebnis> rechnen(UUID siteId, LocalDate tag) {
        Optional<VerbundZeile> gefunden = verbund.derAnlage(siteId);
        if (gefunden.isEmpty() || repo.vorhanden(gefunden.get().id(), tag)) {
            return Optional.empty();
        }
        VerbundZeile v = gefunden.get();
        Instant von = tag.atStartOfDay(GemeinsameSteuerungService.ZONE).toInstant();
        Instant bis = tag.plusDays(1).atStartOfDay(GemeinsameSteuerungService.ZONE).toInstant();
        List<MitgliedZeile> amEnde = verbund.mitglieder(v.id(), bis.minusSeconds(1));
        if (amEnde.isEmpty()) {
            return Optional.empty();
        }
        int erwartet = (int) (Duration.between(von, bis).toMinutes() / 15);

        ObjectNode grundlage = JSON.createObjectNode();
        grundlage.put("fassung", VerbundBilanzRegel.FASSUNG);
        grundlage.put("toleranz", "max(" + VerbundBilanzRegel.TOLERANZ_MIN_KW.toPlainString() + " kW, "
                + VerbundBilanzRegel.TOLERANZ_ANTEIL.movePointRight(2).stripTrailingZeros().toPlainString() + " %)");
        grundlage.put("epoche", v.epoche());
        VerbundBilanzRegel.Grund grund = null;
        Set<UUID> amAnfang = verbund.mitglieder(v.id(), von).stream().map(MitgliedZeile::id)
                .collect(Collectors.toSet());
        if (!amAnfang.equals(amEnde.stream().map(MitgliedZeile::id).collect(Collectors.toSet()))) {
            grund = VerbundBilanzRegel.Grund.STRUKTUR_GEAENDERT;
        }

        MitgliedZeile fuehrt = amEnde.stream().filter(m -> m.rolle() == Rolle.FUEHRT).findFirst().orElse(null);
        List<VerbundBilanzRepository.Term> netz = fuehrt == null || fuehrt.dataSourceId() == null ? List.of()
                : repo.termeDerQuelle(fuehrt.dataSourceId(), von, bis);
        grundlage.set("netzpunkt", terme(netz));
        if (grund == null && netz.isEmpty()) {
            grund = VerbundBilanzRegel.Grund.NETZPUNKT_OHNE_MESSSTELLE;
        }
        List<List<VerbundBilanzRepository.Term>> boxen = new ArrayList<>();
        ArrayNode boxenJson = grundlage.putArray("boxen");
        for (MitgliedZeile m : amEnde) {
            List<VerbundBilanzRepository.Term> t = new ArrayList<>();
            boolean vollstaendig = true;
            if (m.rolle() == Rolle.FUEHRT) {
                for (UUID geraet : repo.geraeteDerBox(m.deviceId(), m.dataSourceId())) {
                    List<VerbundBilanzRepository.Term> g = repo.termeDerKomponente(geraet, von, bis);
                    vollstaendig &= !g.isEmpty();
                    t.addAll(g);
                }
            } else {
                t.addAll(m.dataSourceId() == null ? List.of() : repo.termeDerQuelle(m.dataSourceId(), von, bis));
                vollstaendig = !t.isEmpty();
            }
            if (grund == null && !vollstaendig) {
                grund = VerbundBilanzRegel.Grund.BOX_OHNE_MESSSTELLE;
            }
            boxen.add(t);
            ObjectNode b = boxenJson.addObject();
            b.put("box_id", m.deviceId().toString());
            b.put("rolle", m.rolle().code());
            b.put("messpunkt_id", m.dataSourceId() == null ? null : m.dataSourceId().toString());
            b.put("beitrag", m.rolle() == Rolle.FUEHRT ? "geraetesumme" : "messpunkt");
            b.set("terme", terme(t));
        }
        if (grund == null && (netz.stream().anyMatch(x -> !VORZEICHEN.containsKey(x.richtung()))
                || boxen.stream().flatMap(List::stream).anyMatch(x -> !VORZEICHEN.containsKey(x.richtung())))) {
            grund = VerbundBilanzRegel.Grund.RICHTUNG_NICHT_EINDEUTIG;
        }

        List<VerbundBilanzRegel.Viertelstunde> viertelstunden = new ArrayList<>();
        if (grund == null) {
            Map<String, Map<Instant, BigDecimal>> gelesen = new HashMap<>();
            for (Instant q = von; q.isBefore(bis); q = q.plus(VIERTELSTUNDE)) {
                List<BigDecimal> kw = new ArrayList<>();
                for (List<VerbundBilanzRepository.Term> t : boxen) {
                    kw.add(summe(t, q, tag, gelesen));
                }
                viertelstunden.add(new VerbundBilanzRegel.Viertelstunde(q, summe(netz, q, tag, gelesen), kw));
            }
        }
        VerbundBilanzRegel.Urteil u = VerbundBilanzRegel.tag(erwartet, viertelstunden, grund);

        boolean zurueck = VerbundBilanzRegel.UNPLAUSIBEL.equals(u.zustand())
                && steuerung.bilanzUnplausibel(siteId, tag, ProtokollAkteur.verbundBilanz());
        VerbundBilanzRegel.UrteilViertelstunde g = u.geringstes();
        VerbundBilanzRegel.UrteilViertelstunde h = u.hoechstes();
        VerbundBilanzRepository.Ergebnis e = new VerbundBilanzRepository.Ergebnis(v.id(), siteId, tag, u.zustand(),
                u.grund(), u.erwartet(), u.plausibel(), u.unplausibel(), u.unbekannt(),
                g == null ? null : g.ungeregeltKw(), g == null ? null : g.toleranzKw(), g == null ? null : g.von(),
                grundlage.toString(), v.stufe().code(), zurueck, ProtokollAkteur.verbundBilanz().name(),
                h == null ? null : h.ungeregeltKw(), h == null ? null : h.von());
        repo.speichern(TenantContext.get(), e);
        return Optional.of(e);
    }

    /** Die Summe der Terme einer Viertelstunde mit Vorzeichen; {@code null}, sobald einer nicht vollständig ist (B5). */
    private BigDecimal summe(List<VerbundBilanzRepository.Term> terme, Instant q, LocalDate tag,
            Map<String, Map<Instant, BigDecimal>> gelesen) {
        BigDecimal s = BigDecimal.ZERO;
        for (VerbundBilanzRepository.Term t : terme) {
            BigDecimal kw = gelesen.computeIfAbsent(t.kennzeichen(), k -> lesen(k, tag)).get(q);
            if (kw == null) {
                return null;
            }
            s = s.add(kw.multiply(BigDecimal.valueOf(VORZEICHEN.get(t.richtung()))));
        }
        return s;
    }

    /** Die VOLLSTÄNDIGEN Viertelstunden-Mittel (kW) einer Messstelle am Tag; alles andere fehlt in der Karte. */
    private Map<Instant, BigDecimal> lesen(String kennzeichen, LocalDate tag) {
        MessstelleWerteDto.Werte w = werte.werte(kennzeichen, MessstelleWerteRegeln.Raster.VIERTELSTUNDE.wort(),
                tag.toString(), tag.toString(), null);
        boolean leistung = ErgebnisZustand.KW.equals(w.messstelle().einheit());
        boolean menge = ErgebnisZustand.KWH.equals(w.messstelle().einheit());
        Map<Instant, BigDecimal> out = new HashMap<>();
        for (MessstelleWerteDto.Wert x : w.werte()) {
            if (x.grund() != null || !ErgebnisZustand.VOLLSTAENDIG.equals(x.zustand())) {
                continue;
            }
            Instant a = OffsetDateTime.parse(x.von()).toInstant();
            Instant e = OffsetDateTime.parse(x.bis()).toInstant();
            BigDecimal kw = leistung ? x.mittel() : menge ? GrenzNachweisRegel.mittelAusMenge(x.menge(), a, e) : null;
            if (kw != null) {
                out.put(a, kw);
            }
        }
        return out;
    }

    private static ArrayNode terme(List<VerbundBilanzRepository.Term> terme) {
        ArrayNode a = JSON.createArrayNode();
        for (VerbundBilanzRepository.Term t : terme) {
            a.addObject().put("kennzeichen", t.kennzeichen()).put("richtung", t.richtung());
        }
        return a;
    }
}
