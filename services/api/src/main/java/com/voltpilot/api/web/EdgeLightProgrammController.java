package com.voltpilot.api.web;

import com.voltpilot.api.ota.BoxArt;
import com.voltpilot.api.ota.ReleaseManifest;
import com.voltpilot.api.repo.EdgeLightProgrammRepository;
import com.voltpilot.api.repo.EdgeReleaseRepository;
import com.voltpilot.api.web.dto.EdgeReleaseDto;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Programme der Edge-Light-Releases im Portal (Konzept vp-edge-light-update,
 * K2; Entscheid U-4 A).
 *
 * <p><b>Hochladen</b> ({@code PUT …/edge-releases/{version}/programme/{os}/{arch}?ab=…},
 * Publisher-Konto des Release-Laufs): in Teilen von höchstens
 * {@link #TEIL_MAX} Bytes, damit kein Größenlimit eines Proxys vor der api
 * greift. Prüfsumme und Größe nennt NICHT der Hochladende - sie stehen im
 * signierten Manifest, das schon im Register liegt. Erst wenn die Bytes genau
 * {@code gz_size} lang sind und {@code gz_sha256} tragen, gilt die Lieferung als
 * fertig; eine falsche wird verworfen.
 *
 * <p><b>Abrufen</b> ({@code GET /api/v1/edge/light-programm/{gz_sha256}}, ohne
 * Anmeldung): nur fertige Lieferungen signierter Edge-Light-Releases. Die
 * Echtheit entsteht auf der Box: sie prüft das Manifest gegen ihre eingebackene
 * Wurzel und die geladenen Bytes gegen {@code gz_sha256} aus genau diesem
 * Manifest. Die Route ist nach der Prüfsumme benannt, weil die Box genau sie
 * kennt - auch der Loader, der nach einem Stromausfall beim Flash-Tausch die
 * bestätigte Fassung nachlädt.
 */
@RestController
public class EdgeLightProgrammController {

    private static final String PUBLISH = "hasAnyRole('platform-admin','edge-release-publisher')";

    /** Höchstens 1 MiB je Teil; der Release-Lauf schickt 512 KiB. */
    static final int TEIL_MAX = 1024 * 1024;

    private static final Pattern SHA256 = Pattern.compile("^[0-9a-f]{64}$");
    private static final Pattern TEIL = Pattern.compile("^[a-z0-9]+$");

    private final EdgeReleaseRepository releases;
    private final EdgeLightProgrammRepository programme;

    public EdgeLightProgrammController(EdgeReleaseRepository releases, EdgeLightProgrammRepository programme) {
        this.releases = releases;
        this.programme = programme;
    }

    /** Ein Teil der gepackten Lieferung; {@code ab} = Byte-Versatz (0 beginnt neu). */
    @PutMapping(path = "/api/v1/admin/edge-releases/{version}/programme/{os}/{arch}",
            consumes = MediaType.APPLICATION_OCTET_STREAM_VALUE)
    @PreAuthorize(PUBLISH)
    public Map<String, Object> hochladen(@PathVariable String version, @PathVariable String os,
            @PathVariable String arch, @RequestParam("ab") long ab,
            @RequestBody(required = false) byte[] teil, @AuthenticationPrincipal Jwt caller) {
        if (teil == null || teil.length == 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Der Teil ist leer.");
        }
        if (teil.length > TEIL_MAX) {
            throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE,
                    "Ein Teil darf hoechstens " + TEIL_MAX + " Bytes haben.");
        }
        Ziel ziel = ziel(version, os, arch);
        programme.anlegen(ziel.seq(), ziel.arch(), ziel.program().gzSha256(), ziel.program().gzSize(),
                caller == null ? null : caller.getSubject());
        EdgeLightProgrammRepository.Stand stand = programme.stand(ziel.seq(), ziel.arch()).orElseThrow();
        if (stand.fertig()) {
            // Ein wiederholter Lauf: die Lieferung ist schon da und geprüft.
            return antwort(version, stand);
        }
        boolean geschrieben;
        if (ab == 0) {
            geschrieben = programme.neuBeginnen(ziel.seq(), ziel.arch(), teil);
        } else if (ab == stand.laenge()) {
            geschrieben = programme.anhaengen(ziel.seq(), ziel.arch(), ab, teil);
        } else {
            geschrieben = false;
        }
        if (!geschrieben) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Der Teil passt nicht an die Lieferung (ab " + ab + ", bisher " + stand.laenge()
                            + " Bytes) - von vorn beginnen (ab=0).");
        }
        long laenge = ab + teil.length;
        long soll = ziel.program().gzSize();
        if (laenge > soll) {
            programme.verwerfen(ziel.seq(), ziel.arch());
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Die Lieferung ist laenger als im signierten Manifest (" + soll
                            + " Bytes) - verworfen.");
        }
        if (laenge == soll) {
            String ist = sha256(programme.daten(ziel.seq(), ziel.arch()));
            if (!ist.equals(ziel.program().gzSha256())) {
                programme.verwerfen(ziel.seq(), ziel.arch());
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "Die Pruefsumme der Lieferung passt nicht zum signierten Manifest - verworfen.");
            }
            programme.fertig(ziel.seq(), ziel.arch());
        }
        return antwort(version, programme.stand(ziel.seq(), ziel.arch()).orElseThrow());
    }

    /** Der Stand je Plattform: was das Manifest nennt und was davon fertig ist. */
    @GetMapping("/api/v1/admin/edge-releases/{version}/programme")
    @PreAuthorize("hasRole('platform-admin')")
    public List<Map<String, Object>> stand(@PathVariable String version) {
        EdgeReleaseDto release = lightRelease(version);
        ReleaseManifest m = ReleaseManifest.read(release.manifest());
        Map<String, EdgeLightProgrammRepository.Stand> da = new LinkedHashMap<>();
        programme.alle(release.releaseSeq()).forEach(s -> da.put(s.arch(), s));
        return m.programs().stream().map(p -> {
            EdgeLightProgrammRepository.Stand s = da.get(p.arch());
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("arch", p.arch());
            row.put("gzSha256", p.gzSha256());
            row.put("groesse", p.gzSize());
            row.put("empfangen", s == null ? 0L : s.laenge());
            row.put("fertig", s != null && s.fertig());
            return row;
        }).toList();
    }

    /** Die offene Abruf-Route: nur fertige Programme signierter Edge-Light-Releases. */
    @GetMapping("/api/v1/edge/light-programm/{gzSha256}")
    public ResponseEntity<byte[]> abrufen(@PathVariable String gzSha256) {
        if (!SHA256.matcher(gzSha256).matches()) {
            return ResponseEntity.notFound().build();
        }
        return programme.auslieferbar(gzSha256)
                .map(daten -> ResponseEntity.ok()
                        .contentType(MediaType.parseMediaType("application/gzip"))
                        .contentLength(daten.length)
                        .eTag("\"" + gzSha256 + "\"")
                        // Der Inhalt einer Prüfsumme ändert sich nie.
                        .cacheControl(CacheControl.maxAge(java.time.Duration.ofDays(365)).cachePublic()
                                .immutable())
                        .body(daten))
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    private record Ziel(long seq, String arch, ReleaseManifest.Program program) {
    }

    private Ziel ziel(String version, String os, String arch) {
        if (!TEIL.matcher(os).matches() || !TEIL.matcher(arch).matches()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Keine Plattform wie linux/mipsle.");
        }
        EdgeReleaseDto release = lightRelease(version);
        String plattform = os + "/" + arch;
        ReleaseManifest.Program p = ReleaseManifest.read(release.manifest()).program(plattform)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Das Manifest von " + version + " nennt kein Programm fuer " + plattform + "."));
        return new Ziel(release.releaseSeq(), plattform, p);
    }

    private EdgeReleaseDto lightRelease(String version) {
        EdgeReleaseDto release = releases.findByVersion(version)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Release '" + version + "' ist nicht registriert."));
        if (!BoxArt.LIGHT.equals(BoxArt.ofRelease(release.version(), release.manifest()))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Release '" + version + "' ist kein Edge-Light-Release - es hat keine Programme.");
        }
        if (release.manifest() == null || release.signature() == null) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Release '" + version + "' ist nicht signiert.");
        }
        return release;
    }

    private static Map<String, Object> antwort(String version, EdgeLightProgrammRepository.Stand s) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("version", version);
        out.put("arch", s.arch());
        out.put("empfangen", s.laenge());
        out.put("groesse", s.gzSize());
        out.put("fertig", s.fertig());
        return out;
    }

    static String sha256(byte[] daten) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(daten));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, String>> handle(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode())
                .body(Map.of("message", e.getReason() == null ? "Anfrage abgelehnt." : e.getReason()));
    }
}
