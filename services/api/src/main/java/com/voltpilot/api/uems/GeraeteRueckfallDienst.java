package com.voltpilot.api.uems;

import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.measurement.MeasurementCatalogFamilies;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.GeraeteRueckfall;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Grenzart;
import java.math.BigDecimal;
import java.time.Clock;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Der Geräte-Rückfall je Komponente (UEMS AP-15 IP-6, Regel G3, Kasten E2 = A): lesen und hinterlegen. Die Zahl macht
 * allein {@link GeraeteRueckfallRegel}; dieser Dienst holt ihre drei Eingänge — die wirksame Angabe am Gerät
 * ({@code komponente_geraete_rueckfall}), den Katalog-Eintrag der Familie ({@code families[].rueckfall_ohne_box})
 * und die Nennleistung, die der Aufrufer kennt (IP-7 summiert je Box, was hinter ihrem Abgang liegt). Die Komponente
 * wird über {@code measurement_point} gelesen — unter RLS und Standort-Zaun: eine fremde oder unsichtbare gibt es
 * nicht. Eine Route hat dieses Paket nicht (Folgepunkt IP-5/IP-24).
 */
@Service
public class GeraeteRueckfallDienst {

    private final GeraeteRueckfallRepository angaben;
    private final MeasurementCatalog katalog;
    private final JdbcTemplate jdbc;
    private final Clock clock;

    @Autowired
    public GeraeteRueckfallDienst(GeraeteRueckfallRepository angaben, MeasurementCatalog katalog, JdbcTemplate jdbc) {
        this(angaben, katalog, jdbc, Clock.systemUTC());
    }

    GeraeteRueckfallDienst(GeraeteRueckfallRepository angaben, MeasurementCatalog katalog, JdbcTemplate jdbc,
            Clock clock) {
        this.angaben = angaben;
        this.katalog = katalog;
        this.jdbc = jdbc;
        this.clock = clock;
    }

    /** Die Komponente fehlt oder ist für diese Anfrage nicht sichtbar. */
    public static final class KomponenteFehlt extends RuntimeException {
        public KomponenteFehlt(UUID komponente) {
            super("Komponente nicht gefunden: " + komponente);
        }
    }

    /**
     * Der Rückfall dieser Komponente in kW in einer Richtung: hinterlegter Wert, sonst Katalog-Eintrag, sonst
     * {@code unbekannt} → Nennleistung. Der hinterlegte Wert zählt nur, solange DERSELBE Einbau die Komponente
     * speist, an dem er eingetragen wurde — nach einem Tausch steckt er im alten Gerät.
     */
    @Transactional(readOnly = true)
    public GeraeteRueckfallRegel.Rueckfall rueckfall(UUID komponente, Grenzart richtung, BigDecimal nennKw) {
        String familie = komponente(komponente).familie();
        GeraeteRueckfallRepository.Zeile amGeraet = gueltig(komponente, richtung);
        return GeraeteRueckfallRegel.rueckfall(richtung, amGeraet == null ? null : amGeraet.angabe(),
                katalogEintrag(familie, richtung), nennKw);
    }

    /** Die wirksame Angabe, wenn sie am Einbau von jetzt eingetragen wurde, sonst {@code null}. */
    private GeraeteRueckfallRepository.Zeile gueltig(UUID komponente, Grenzart richtung) {
        GeraeteRueckfallRepository.Zeile zeile = angaben.wirksam(komponente, richtung.code());
        if (zeile == null || !Objects.equals(zeile.geraet(), angaben.einbauJetzt(komponente, clock.instant()))) {
            return null;
        }
        return zeile;
    }

    /**
     * Der Katalog-Eintrag für die Katalog-Familien einer Registry-Familie ({@link MeasurementCatalogFamilies#expand}).
     * Sagen mehrere Familien (SunSpec: jedes Modell eine) Verschiedenes, gilt keiner — dann {@code null}, also
     * {@code unbekannt} zur sicheren Seite.
     */
    GeraeteRueckfallRegel.Angabe katalogEintrag(String familie, Grenzart richtung) {
        if (familie == null) {
            return null;
        }
        Set<MeasurementCatalog.RueckfallOhneBox> eintraege = new LinkedHashSet<>();
        for (String f : MeasurementCatalogFamilies.expand(Set.of(familie), katalog.families())) {
            MeasurementCatalog.RueckfallOhneBox e = katalog.rueckfallOhneBox(f, richtung.code());
            if (e != null) {
                eintraege.add(e);
            }
        }
        if (eintraege.size() != 1) {
            return null;
        }
        MeasurementCatalog.RueckfallOhneBox e = eintraege.iterator().next();
        return new GeraeteRueckfallRegel.Angabe(wort(e.rueckfall()), e.rueckfallKw(), e.nachS());
    }

    /**
     * Hinterlegt, was am Gerät eingestellt ist (wer/wann), und hebt die bisherige Angabe dieser Richtung auf. Dieselbe
     * Angabe noch einmal schreibt nichts. Der Mandant kommt aus der Komponente, die unter RLS sichtbar ist — nie vom
     * Aufrufer. Keine Bestätigung am Prüfstand — die trägt nur der Betreiber ein (NW-7).
     */
    @Transactional
    public GeraeteRueckfallRepository.Zeile hinterlegen(UUID komponente, Grenzart richtung,
            GeraeteRueckfallRegel.Angabe angabe, String hinweis, String wer) {
        if (richtung != Grenzart.EINSPEISUNG && richtung != Grenzart.BEZUG) {
            throw new IllegalArgumentException("nur einspeisung und bezug: " + richtung);
        }
        if (angabe.rueckfall() == GeraeteRueckfall.FAELLT_AUF_WERT && angabe.rueckfallKw() == null) {
            throw new IllegalArgumentException("faellt_auf_wert braucht den Wert in kW");
        }
        if (wer == null || wer.isBlank()) {
            throw new IllegalArgumentException("wer fehlt");
        }
        UUID tenant = komponente(komponente).tenant();
        angaben.sperren(komponente);
        UUID einbau = angaben.einbauJetzt(komponente, clock.instant());
        GeraeteRueckfallRepository.Zeile alt = angaben.wirksam(komponente, richtung.code());
        if (alt != null && alt.angabe().equals(normiert(angabe)) && Objects.equals(alt.hinweis(), hinweis)
                && Objects.equals(alt.geraet(), einbau)) {
            return alt;
        }
        if (alt != null) {
            angaben.aufheben(alt.id(), clock.instant());
        }
        angaben.eintragen(tenant, komponente, einbau, richtung.code(), angabe, hinweis, wer);
        return angaben.wirksam(komponente, richtung.code());
    }

    /** Alle Angaben einer Komponente, neueste zuerst — das Protokoll mit wer/wann. */
    @Transactional(readOnly = true)
    public List<GeraeteRueckfallRepository.Zeile> verlauf(UUID komponente) {
        komponente(komponente);
        return angaben.verlauf(komponente);
    }

    private record Komponente(UUID tenant, String familie) {}

    private Komponente komponente(UUID komponente) {
        List<Komponente> zeilen = jdbc.query("SELECT tenant_id, family FROM measurement_point WHERE id = ?",
                (rs, n) -> new Komponente(rs.getObject("tenant_id", UUID.class), rs.getString("family")), komponente);
        if (zeilen.isEmpty()) {
            throw new KomponenteFehlt(komponente);
        }
        return zeilen.get(0);
    }

    private static GeraeteRueckfallRegel.Angabe normiert(GeraeteRueckfallRegel.Angabe a) {
        BigDecimal kw = a.rueckfallKw() == null ? null : a.rueckfallKw().stripTrailingZeros();
        if (kw != null && kw.scale() < 0) {
            kw = kw.setScale(0);
        }
        return new GeraeteRueckfallRegel.Angabe(a.rueckfall(), kw, a.nachS());
    }

    private static GeraeteRueckfall wort(String code) {
        return Arrays.stream(GeraeteRueckfall.values()).filter(w -> w.code().equals(code)).findFirst()
                .orElseThrow(() -> new IllegalStateException("Katalog kennt das Wort nicht: " + code));
    }
}
