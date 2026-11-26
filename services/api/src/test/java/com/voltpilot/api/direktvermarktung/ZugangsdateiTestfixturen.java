package com.voltpilot.api.direktvermarktung;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import net.lingala.zip4j.io.outputstream.ZipOutputStream;
import net.lingala.zip4j.model.ZipParameters;
import net.lingala.zip4j.model.enums.EncryptionMethod;

/**
 * Ein echtes, zufällig erzeugtes RSA-Testpaar (openssl, kein Bezug zu einer echten Anlage) und eine
 * fertige OpenVPN-"unified"-Konfiguration daraus - gemeinsame Prüflinge für {@link ZugangsdateiOeffnerTest}
 * und {@code SiteDirektvermarktungApiTest}, damit das Zertifikat nur einmal im Repository steht.
 */
final class ZugangsdateiTestfixturen {

    private ZugangsdateiTestfixturen() {}

    static final String CERT_GUELTIG = """
            -----BEGIN CERTIFICATE-----
            MIIDCzCCAfOgAwIBAgIUdbNOBXenAIMRdSj0S3RqJMMqZiQwDQYJKoZIhvcNAQEL
            BQAwFTETMBEGA1UEAwwKdGVzdC12YWxpZDAeFw0yNjExMjYwNDI1NDFaFw0zNjEx
            MjMwNDI1NDFaMBUxEzARBgNVBAMMCnRlc3QtdmFsaWQwggEiMA0GCSqGSIb3DQEB
            AQUAA4IBDwAwggEKAoIBAQDIJw/Y7k5WV1XeoYrDSnSf0qNl9QcxHrE6imKkJlf0
            Qe4knlx7v3hFHddGpeY8shafqu041SLtgornC7PAZOjvJo/KII6V9e0vSN8km5E0
            QJRQABLQ4KvEn30hJT3qZVz3QAyk2QPZhi7TYIUGe4cQIfSFcZHFH02oErh/Zn1L
            nAz1Fi9cg4V3Lgz+51vY6fhcAj7PS6qss+Nuagkifqr0cznv0nBmovO4OfmlpXwu
            CAS663IR11FMefWc+4kDXEneyqAKxd0E7zvrO0NsNyDvKFGn582UTVRGm1xX3ylE
            C86CD3dz+xP2Yw9oB2neL03DT6XGTSzIhsk/h2LDoT/NAgMBAAGjUzBRMB0GA1Ud
            DgQWBBSTniEWrioRt096gYyr62As+dyzhTAfBgNVHSMEGDAWgBSTniEWrioRt096
            gYyr62As+dyzhTAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQC9
            ifSB/qCY6vu4/AofxWNqaX0UcBYGSQXUXRIAlpsiBNMFA3QrKiJwYIyHLMFbgNYd
            6s9vWiHngSXmW9Tua+B/MH48vK7kGH4MeRPbPJVgm8fYrKB8UAeHrRVhAZp3A7KN
            35JuboecAWaJnyi9VPAP9B2xjebpgoIVvUP4f85FHHTzo6oHgtCfr+msVF2Zxjpn
            p3Od27cGB/XaR3Pcq1UrjK4n9DxdMlTuwcFBviAHmVsqafZjf3e8CcCfewFuTqCq
            6SRmAM/xJKYE7EF/lDO0jkvilUF9IHU6oMKor32tDNyWLWMsKIbqpLlUava9RQQh
            +Mi9kBkgvRVCi+TMgCEG
            -----END CERTIFICATE-----
            """;

    static final String KEY = """
            -----BEGIN PRIVATE KEY-----
            MIIEuwIBADANBgkqhkiG9w0BAQEFAASCBKUwggShAgEAAoIBAQDIJw/Y7k5WV1Xe
            oYrDSnSf0qNl9QcxHrE6imKkJlf0Qe4knlx7v3hFHddGpeY8shafqu041SLtgorn
            C7PAZOjvJo/KII6V9e0vSN8km5E0QJRQABLQ4KvEn30hJT3qZVz3QAyk2QPZhi7T
            YIUGe4cQIfSFcZHFH02oErh/Zn1LnAz1Fi9cg4V3Lgz+51vY6fhcAj7PS6qss+Nu
            agkifqr0cznv0nBmovO4OfmlpXwuCAS663IR11FMefWc+4kDXEneyqAKxd0E7zvr
            O0NsNyDvKFGn582UTVRGm1xX3ylEC86CD3dz+xP2Yw9oB2neL03DT6XGTSzIhsk/
            h2LDoT/NAgMBAAECgf9/Ap09XhzcCD0rGh3bW9euOPQMAR6fumasKrEjaL3z739x
            SbHqgo3Pf9XiSVPRD0IzOVzcHwll4AWfwWouewPJIbeIe9YgfINQ2P3JNO7vtWYm
            JDhhGlIXOdOph3RXezTumHyGUM0H0MOTkILqLtPpeWCINNOmlcMUw6MnA7EC3WdV
            Er0Fdnh1bv6a4ksOh84gACBD+hpCsJiJGUlIH3SsaHnLmNGQCXHH6ezULxXZEtoy
            C3CVpZW0K8KlGURST5ZKFuHFndsZUro9iTU+PJZVTsKJXWaqkGEe7FIRi+eE2FdC
            TUuq9BIOE4kfQJJEbpzrx8GcYNrP5U2F2hEJIgECgYEA+R9z3OdbO2oLoN5nXjTm
            mdJr6EGih2xY3lazKGGBnuQ4LX+dI+S1/pRGEK60fy1tOmFvK3YwVrRZMLiVTygv
            K7iFxgpCmSqjjwGqXeLbXL599EPsMITi8fMMm1iP0Hh4ZhpbwOVeYjMcgcaI906n
            JisYlW+QieD1Kdc+nwIPFm0CgYEAza2JgWGGA7gWeUhxj9S8XlFduFhtfQ6CcHRo
            kcSqJNXiacEFdmW8tHYyZAhbq+w5Tj8PwsUMEzRet04AFkVffF1f4SJLUv30AZPz
            +ireeUcYrig1dZBivOam6oqz8G58pt5aL0jh1ZZpdeI8In3jFP35mw7zT8u/zVzO
            ZLiqcuECgYEAzNKyVS6W0Pu4gdQ50rfV3SSnebb1JTjMvEk2Vf4NL5FeKvJgRZGW
            nLBWBwNM/b9grf5MA8TRq4fuSOOKRyG33s+AlTn8Vag7/6kT5MtPJiqsrjdmKuIn
            IVx+wf6Hh5R1ESWcyLUM69owFvcfx42QWg5W0Q6AHQyrJXKGVv+/XeUCgYBeJbSO
            q8R7iVWIONf6vadoCRi8XIXpu62Lqk1/hCVZ7SnRvNAyTQmfFYelcIn93Yixv34I
            ashHNi6w+5xglWrK87cCx/7ww1xhKIeCmQLzQs8SUUd/RBNeYro/HDSXtwuKGrfv
            cw4lBc/KbT+XjkZXApayGprXiO2IJJY5Vqp3IQKBgEbnfS2UksZYkBLO/u2Mv2/+
            CuYZvPuM2mNqzPmmeJ/e0hILp6MAPxA1zj1URPDVerolq9pK4qDz1zK8ZUduouXd
            QpDUuUDAvYRA5+GiFR9pJxvYVd0Lsle+UGxVu/jDMoRNcO88jO4BLWZQoTeAiq+N
            Fs5mXHNi66aZlxNcfGWU
            -----END PRIVATE KEY-----
            """;

    static final String CA = CERT_GUELTIG;

    static final String CERT_ABGELAUFEN = """
            -----BEGIN CERTIFICATE-----
            MIIDDzCCAfegAwIBAgIUeTXXF++hcGIrKp3Rjwz0onONb0owDQYJKoZIhvcNAQEL
            BQAwFzEVMBMGA1UEAwwMdGVzdC1leHBpcmVkMB4XDTIwMDEwMTAwMDAwMFoXDTIw
            MDEwMjAwMDAwMFowFzEVMBMGA1UEAwwMdGVzdC1leHBpcmVkMIIBIjANBgkqhkiG
            9w0BAQEFAAOCAQ8AMIIBCgKCAQEAlLNpFEF6Xwo2kg36iRIAc03dnXRueKMzx2h8
            uiEM9ElEvtXZZ8plh+2TwL0HL1UdEXGWCi0ySU7mfrc57DBL60mJMtrIaUmB0e8C
            w36CvbR0odN4R40lYQi+fsXkJZG+d2iMAeWwNUkHWpwVUdQGMzlnpDFwKX+2be1c
            yiV2YFIKs/hEUgWzWaIpAy/Oa+rNILr60Andr5vAmaABWW3gzywqMInvoIAhr3jM
            0JMobw1e2MuV2CR17YGl7QB2rPtQfMdHGY0iniMveytdOcLq3VcKTAR5fVowZfZk
            kIgmNnsTIL4t+WnHJC3z8TUsp4wrKgKU4gHAUBGWKyVr7rJtEwIDAQABo1MwUTAd
            BgNVHQ4EFgQUPFT3jC+19QzGeXvfN9IBj0dkJbIwHwYDVR0jBBgwFoAUPFT3jC+1
            9QzGeXvfN9IBj0dkJbIwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOC
            AQEATb44MXQW6Z19j7GhrEtacMz6VvdR+tgST1kFC04UzaSdFZMuIeleEaB/vBTN
            rd53iMnYf0N2rK1Ho1T3NajLFUdM/RUtoH7D+JY2xnZVHABFqhjuRMGaPFPYaZqZ
            mt//Cv7OfeC2gz9JDq99XcCNU4b0uxt0b9QtKsE5HvIBHPdgGFkfdrgfKzvxpR1/
            4GsY6BDwgTt41a+lkLely46uWGfvyU317ohOmBgP481A9zSTBNFE7vnUHcbAoSZS
            ayObqq6TSr3HSzQTPUhYDMYQsXeFcGJeR74iV4n6zYcVq+k+536TxLklih23RP2M
            ME5g89PQ+QvxGJ9yxzGsPiWJSQ==
            -----END CERTIFICATE-----
            """;

    /** Eine vollständige OpenVPN-"unified"-Konfiguration mit gültigem Zertifikat und tls-crypt-Schlüssel. */
    static final String OVPN_GUELTIG = """
            client
            dev tun
            proto udp
            remote vpn.luox-energy.de 1194 udp
            <ca>
            %s</ca>
            <cert>
            %s</cert>
            <key>
            %s</key>
            <tls-crypt>
            -----BEGIN OpenVPN Static key V1-----
            0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd
            -----END OpenVPN Static key V1-----
            </tls-crypt>
            """.formatted(CA, CERT_GUELTIG, KEY);

    /** Ein beliebiger Testschlüssel für {@code VP_PARTNERZUGANG_SCHLUESSEL} (32 Byte, Base64). */
    static String testSchluesselBase64() {
        byte[] k = new byte[32];
        for (int i = 0; i < k.length; i++) k[i] = (byte) i;
        return java.util.Base64.getEncoder().encodeToString(k);
    }

    /** Baut ein passwortgeschütztes ZIP im Speicher (zip4j, AES) - nie ein Byte auf der Platte. */
    static byte[] baueZip(String passwort, Map<String, String> eintraege) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        char[] pw = passwort == null ? null : passwort.toCharArray();
        try (ZipOutputStream zos = pw == null ? new ZipOutputStream(bos) : new ZipOutputStream(bos, pw)) {
            for (Map.Entry<String, String> e : eintraege.entrySet()) {
                ZipParameters params = new ZipParameters();
                params.setFileNameInZip(e.getKey());
                if (pw != null) {
                    params.setEncryptFiles(true);
                    params.setEncryptionMethod(EncryptionMethod.AES);
                }
                zos.putNextEntry(params);
                zos.write(e.getValue().getBytes(StandardCharsets.UTF_8));
                zos.closeEntry();
            }
        }
        return bos.toByteArray();
    }
}
