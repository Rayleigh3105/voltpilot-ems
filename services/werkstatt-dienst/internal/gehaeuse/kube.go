package gehaeuse

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ImBild ist der Ordner aus/ des Gehäuse-Programms im Bau-Image
// (services/werkstatt-dienst/gehaeuse/Dockerfile). Dort hängt der Job den
// Unterordner der Ablage ein, in den das Programm schreibt.
const ImBild = "/opt/vp/edge-light/gehaeuse/glinet-gl-mt300n-v2/aus"

// Dienstkonto im Pod (Kubernetes legt es dort ab).
const dienstkonto = "/var/run/secrets/kubernetes.io/serviceaccount"

// Kube baut im Cluster: je Auftrag ein Job mit dem Bau-Image, der die Ablage
// (PVC) einhängt, nur den Unterordner dieses Auftrags. Der Dienst braucht dafür
// genau: Jobs anlegen, lesen, löschen und Pods lesen, nur im eigenen Namespace
// (Role werkstatt-dienst-gehaeuse).
type Kube struct {
	API        string // https://<KUBERNETES_SERVICE_HOST>:<PORT>
	HTTP       *http.Client
	Token      func() (string, error)
	Namespace  string
	Image      string // Bau-Image, fest nach Digest
	PVC        string // Ablage der Gehäuse (ReadWriteOnce, local-path)
	Ablage     string // wo der Dienst diese PVC eingehängt hat
	PullSecret string
	Speicher   string // Grenze des Arbeitsspeichers für den Bau (PS-8)
	Frist      time.Duration
	Takt       time.Duration
	Log        *slog.Logger
}

// AusCluster liest Adresse, CA, Token und Namespace des Dienstkontos im Pod.
func AusCluster(k Kube) (*Kube, error) {
	host, port := os.Getenv("KUBERNETES_SERVICE_HOST"), os.Getenv("KUBERNETES_SERVICE_PORT")
	if host == "" || port == "" {
		return nil, errors.New("kein Kubernetes im Pod (KUBERNETES_SERVICE_HOST fehlt)")
	}
	ca, err := os.ReadFile(filepath.Join(dienstkonto, "ca.crt"))
	if err != nil {
		return nil, fmt.Errorf("Dienstkonto nicht eingehängt (automountServiceAccountToken): %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(ca) {
		return nil, errors.New("ca.crt des Dienstkontos unlesbar")
	}
	ns, err := os.ReadFile(filepath.Join(dienstkonto, "namespace"))
	if err != nil {
		return nil, err
	}
	k.API = "https://" + net.JoinHostPort(host, port)
	k.HTTP = &http.Client{Timeout: 15 * time.Second, Transport: &http.Transport{
		TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}}}
	k.Token = func() (string, error) {
		// Jedes Mal neu lesen: Das Token des Dienstkontos wird erneuert.
		t, err := os.ReadFile(filepath.Join(dienstkonto, "token"))
		return strings.TrimSpace(string(t)), err
	}
	k.Namespace = strings.TrimSpace(string(ns))
	return &k, nil
}

func (k *Kube) Baue(ctx context.Context, ref, ziel string, meldeJob func(string)) error {
	sub, err := filepath.Rel(k.Ablage, ziel)
	if err != nil || sub == "." || strings.HasPrefix(sub, "..") {
		return fmt.Errorf("Ziel %s liegt nicht in der Ablage %s", ziel, k.Ablage)
	}
	name := "gehaeuse-" + ref + "-" + time.Now().UTC().Format("150405")
	if err := k.anfrage(ctx, http.MethodPost, k.pfad("apis/batch/v1", "jobs", ""), k.job(name, ref, filepath.ToSlash(sub)), nil); err != nil {
		return fmt.Errorf("Job anlegen: %w", err)
	}
	meldeJob(name)
	k.Log.Info("Gehäuse: Job angelegt", "referenz", ref, "job", name)
	fertig := false
	defer func() {
		if fertig {
			return
		}
		// Abbruch, Frist oder Ende des Dienstes: Der Job darf nicht weiterlaufen,
		// sonst bauten nach dem Neustart zwei zugleich.
		dctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := k.loesche(dctx, name); err != nil {
			k.Log.Warn("Gehäuse: Job nicht gelöscht", "job", name, "fehler", err)
		}
	}()
	takt := k.Takt
	if takt <= 0 {
		takt = 5 * time.Second
	}
	var hinweis string
	for {
		select {
		case <-ctx.Done():
			if hinweis != "" {
				return fmt.Errorf("%w (zuletzt: %s)", ctx.Err(), hinweis)
			}
			return ctx.Err()
		case <-time.After(takt):
		}
		var j jobStand
		if err := k.anfrage(ctx, http.MethodGet, k.pfad("apis/batch/v1", "jobs", name), nil, &j); err != nil {
			if ctx.Err() == nil {
				hinweis = "Job lesen: " + err.Error()
			}
			continue
		}
		for _, c := range j.Status.Conditions {
			if c.Status != "True" {
				continue
			}
			switch c.Type {
			case "Complete":
				fertig = true
				return nil
			case "Failed":
				fertig = true
				return fmt.Errorf("Job gescheitert (%s)%s", c.Reason, mitText(c.Message))
			}
		}
		h, endgueltig := k.podHinweis(ctx, name)
		if h != "" {
			hinweis = h
		}
		if endgueltig {
			return errors.New(h)
		}
	}
}

// podHinweis liest, was den Pod des Jobs aufhält. endgueltig: Es wird ohne
// Eingriff nicht besser (das Bild ist nicht zu laden).
func (k *Kube) podHinweis(ctx context.Context, job string) (string, bool) {
	var l podListe
	q := url.Values{"labelSelector": {"job-name=" + job}}
	if err := k.anfrage(ctx, http.MethodGet, k.pfad("api/v1", "pods", "")+"?"+q.Encode(), nil, &l); err != nil {
		return "", false
	}
	for _, p := range l.Items {
		for _, c := range p.Status.ContainerStatuses {
			if w := c.State.Waiting; w != nil {
				switch w.Reason {
				case "ErrImagePull", "ImagePullBackOff", "InvalidImageName", "CreateContainerConfigError", "CreateContainerError":
					return "Bau-Image: " + w.Reason + mitText(w.Message), true
				}
				if w.Reason != "" {
					return "Pod wartet: " + w.Reason, false
				}
			}
		}
		for _, c := range p.Status.Conditions {
			if c.Type == "PodScheduled" && c.Status == "False" {
				return "Pod nicht eingeplant: " + c.Reason + mitText(c.Message), false
			}
		}
	}
	return "", false
}

func mitText(s string) string {
	if s = kurz(s); s == "" {
		return ""
	}
	return ": " + s
}

func kurz(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 300 {
		s = s[:300] + " …"
	}
	return s
}

func (k *Kube) loesche(ctx context.Context, name string) error {
	body := map[string]any{"kind": "DeleteOptions", "apiVersion": "v1", "propagationPolicy": "Background"}
	err := k.anfrage(ctx, http.MethodDelete, k.pfad("apis/batch/v1", "jobs", name), body, nil)
	var a *apiFehler
	if errors.As(err, &a) && a.Status == http.StatusNotFound {
		return nil
	}
	return err
}

func (k *Kube) pfad(gruppe, art, name string) string {
	p := k.API + "/" + gruppe + "/namespaces/" + url.PathEscape(k.Namespace) + "/" + art
	if name != "" {
		p += "/" + url.PathEscape(name)
	}
	return p
}

type apiFehler struct {
	Status  int
	Meldung string
}

func (e *apiFehler) Error() string {
	if e.Status == http.StatusForbidden {
		return fmt.Sprintf("HTTP 403, dem Dienstkonto fehlt das Recht (Role werkstatt-dienst-gehaeuse): %s", e.Meldung)
	}
	return fmt.Sprintf("HTTP %d: %s", e.Status, e.Meldung)
}

func (k *Kube) anfrage(ctx context.Context, methode, ziel string, body, antwort any) error {
	var rein io.Reader
	if body != nil {
		roh, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rein = bytes.NewReader(roh)
	}
	req, err := http.NewRequestWithContext(ctx, methode, ziel, rein)
	if err != nil {
		return err
	}
	t, err := k.Token()
	if err != nil {
		return fmt.Errorf("Token des Dienstkontos: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+t)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := k.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	roh, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if res.StatusCode/100 != 2 {
		var s struct {
			Message string `json:"message"`
		}
		_ = json.Unmarshal(roh, &s)
		if s.Message == "" {
			s.Message = strings.TrimSpace(string(roh))
		}
		return &apiFehler{Status: res.StatusCode, Meldung: kurz(s.Message)}
	}
	if antwort != nil {
		return json.Unmarshal(roh, antwort)
	}
	return nil
}

type jobStand struct {
	Status struct {
		Conditions []struct {
			Type, Status, Reason, Message string
		} `json:"conditions"`
	} `json:"status"`
}

type podListe struct {
	Items []struct {
		Status struct {
			Conditions []struct {
				Type, Status, Reason, Message string
			} `json:"conditions"`
			ContainerStatuses []struct {
				State struct {
					Waiting *struct {
						Reason, Message string
					} `json:"waiting"`
				} `json:"state"`
			} `json:"containerStatuses"`
		} `json:"status"`
	} `json:"items"`
}

// job ist der Job eines Auftrags: das Bau-Image unter PodSecurity
// „restricted“, ohne Dienstkonto-Token, ohne Netz (NetworkPolicy
// werkstatt-gehaeuse), mit dem Unterordner der Ablage als aus/ des Programms.
func (k *Kube) job(name, ref, sub string) map[string]any {
	labels := map[string]any{"app.kubernetes.io/name": "werkstatt-gehaeuse", "app.kubernetes.io/part-of": "werkstatt"}
	frist := int64(k.Frist / time.Second)
	if frist <= 0 {
		frist = 1200
	}
	speicher := k.Speicher
	if speicher == "" {
		speicher = "4Gi"
	}
	pod := map[string]any{
		"restartPolicy":                "Never",
		"automountServiceAccountToken": false,
		"enableServiceLinks":           false,
		"nodeSelector":                 map[string]any{"kubernetes.io/arch": "amd64"},
		"securityContext": map[string]any{
			"runAsNonRoot": true, "runAsUser": 10001, "runAsGroup": 10001, "fsGroup": 10001,
			"seccompProfile": map[string]any{"type": "RuntimeDefault"},
		},
		"containers": []any{map[string]any{
			"name":  "bau",
			"image": k.Image,
			"args":  []any{ref},
			"env": []any{
				map[string]any{"name": "HOME", "value": "/tmp"},
				map[string]any{"name": "PYTHONDONTWRITEBYTECODE", "value": "1"},
			},
			"resources": map[string]any{
				"requests": map[string]any{"cpu": "1", "memory": "1Gi"},
				"limits":   map[string]any{"memory": speicher},
			},
			"securityContext": map[string]any{
				"allowPrivilegeEscalation": false, "readOnlyRootFilesystem": true,
				"capabilities": map[string]any{"drop": []any{"ALL"}},
			},
			"volumeMounts": []any{
				map[string]any{"name": "ablage", "mountPath": ImBild, "subPath": sub},
				map[string]any{"name": "tmp", "mountPath": "/tmp"},
			},
		}},
		"volumes": []any{
			map[string]any{"name": "ablage", "persistentVolumeClaim": map[string]any{"claimName": k.PVC}},
			map[string]any{"name": "tmp", "emptyDir": map[string]any{"sizeLimit": "4Gi"}},
		},
	}
	if k.PullSecret != "" {
		pod["imagePullSecrets"] = []any{map[string]any{"name": k.PullSecret}}
	}
	return map[string]any{
		"apiVersion": "batch/v1",
		"kind":       "Job",
		"metadata": map[string]any{
			"name": name, "labels": labels,
			"annotations": map[string]any{"voltpilot.de/referenz": ref},
		},
		"spec": map[string]any{
			"backoffLimit":            0,
			"activeDeadlineSeconds":   frist,
			"ttlSecondsAfterFinished": 3600,
			"template": map[string]any{
				"metadata": map[string]any{"labels": labels},
				"spec":     pod,
			},
		},
	}
}
