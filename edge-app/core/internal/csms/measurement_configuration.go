package csms

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"time"
)

const measurementConfigurationFile = "ocpp-measurement-configuration.json"

var measurementConfigurationKeys = map[string]bool{
	"MeterValuesSampledData": true,
	"StopTxnSampledData":     true,
}

// MeasurementConfiguration is the durable Core-owned station desired state.
// It deliberately contains OCPP keys, not catalog point names: the Node-RED
// planner owns the catalog-to-OCPP translation, while the CSMS owns delivery,
// station acknowledgement, readback and reconnect reconciliation.
type MeasurementConfiguration struct {
	Revision int64             `json:"revision"`
	Values   map[string]string `json:"values"`
}

type MeasurementConfigurationResult struct {
	Revision int64  `json:"revision"`
	Applied  bool   `json:"applied"`
	Reason   string `json:"reason,omitempty"`
}

func validateMeasurementConfiguration(desired MeasurementConfiguration) error {
	if desired.Revision < 1 || len(desired.Values) == 0 || len(desired.Values) > len(measurementConfigurationKeys) {
		return errors.New("invalid OCPP measurement configuration")
	}
	for key, value := range desired.Values {
		if !measurementConfigurationKeys[key] || strings.TrimSpace(value) == "" || len(value) > 1024 {
			return fmt.Errorf("invalid OCPP measurement configuration key %q", key)
		}
	}
	return nil
}

func loadMeasurementConfiguration(dir string) (MeasurementConfiguration, error) {
	var desired MeasurementConfiguration
	raw, err := os.ReadFile(filepath.Join(dir, measurementConfigurationFile))
	if os.IsNotExist(err) {
		return desired, nil
	}
	if err != nil {
		return desired, err
	}
	if err := json.Unmarshal(raw, &desired); err != nil {
		return desired, err
	}
	if err := validateMeasurementConfiguration(desired); err != nil {
		return desired, err
	}
	return desired, nil
}

func persistMeasurementConfiguration(dir string, desired MeasurementConfiguration) error {
	raw, err := json.Marshal(desired)
	if err != nil {
		return err
	}
	tmp := filepath.Join(dir, measurementConfigurationFile+".tmp")
	path := filepath.Join(dir, measurementConfigurationFile)
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err = f.Write(raw); err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(tmp, path); err != nil {
		return err
	}
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

// SetMeasurementConfiguration persists before attempting a station command.
// With no connected station it returns successfully but emits no result; the
// desired keys are retried automatically at the next connect/boot.
func (s *Server) SetMeasurementConfiguration(ctx context.Context, desired MeasurementConfiguration) error {
	if err := validateMeasurementConfiguration(desired); err != nil {
		return err
	}
	s.measurementApplyMu.Lock()
	defer s.measurementApplyMu.Unlock()
	s.mu.Lock()
	current := s.measurementDesired
	if desired.Revision < current.Revision ||
		(desired.Revision == current.Revision && !reflect.DeepEqual(desired.Values, current.Values)) {
		s.mu.Unlock()
		return errors.New("stale OCPP measurement configuration")
	}
	s.mu.Unlock()
	if desired.Revision > current.Revision {
		if err := persistMeasurementConfiguration(s.opts.DataDir, desired); err != nil {
			return err
		}
		s.mu.Lock()
		s.measurementDesired = MeasurementConfiguration{Revision: desired.Revision,
			Values: cloneStringMap(desired.Values)}
		s.mu.Unlock()
	}
	return s.reconcileMeasurementConfigurationLocked(ctx)
}

func (s *Server) reconcileMeasurementConfigurationAsync() {
	s.mu.Lock()
	hasDesired := s.measurementDesired.Revision > 0
	s.mu.Unlock()
	if !hasDesired {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := s.reconcileMeasurementConfiguration(ctx); err != nil {
			s.log.Warn("OCPP measurement configuration reconciliation failed", "err", err)
		}
	}()
}

func (s *Server) reconcileMeasurementConfiguration(ctx context.Context) error {
	s.measurementApplyMu.Lock()
	defer s.measurementApplyMu.Unlock()
	return s.reconcileMeasurementConfigurationLocked(ctx)
}

func (s *Server) reconcileMeasurementConfigurationLocked(ctx context.Context) error {
	s.mu.Lock()
	desired := s.measurementDesired
	connected := make([]string, 0, len(s.chargers))
	for id, charger := range s.chargers {
		if charger.Connected {
			connected = append(connected, id)
		}
	}
	s.mu.Unlock()
	if desired.Revision == 0 || len(connected) == 0 {
		return nil
	}
	sort.Strings(connected)
	keys := make([]string, 0, len(desired.Values))
	for key := range desired.Values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, id := range connected {
		t, err := s.liveTransport(id)
		if err != nil {
			return s.measurementConfigurationFailed(desired.Revision, err)
		}
		for _, key := range keys {
			if _, err := t.changeConfiguration(ctx, id, key, desired.Values[key]); err != nil {
				return s.measurementConfigurationFailed(desired.Revision, err)
			}
		}
		values, unknown, err := t.getConfiguration(ctx, id, keys)
		if err != nil {
			return s.measurementConfigurationFailed(desired.Revision, err)
		}
		if len(unknown) != 0 {
			return s.measurementConfigurationFailed(desired.Revision,
				fmt.Errorf("unknown OCPP configuration keys: %v", unknown))
		}
		for _, key := range keys {
			if values[key] != desired.Values[key] {
				return s.measurementConfigurationFailed(desired.Revision,
					fmt.Errorf("OCPP readback mismatch for %s", key))
			}
		}
	}
	if callback := s.opts.OnMeasurementConfigurationResult; callback != nil {
		callback(MeasurementConfigurationResult{Revision: desired.Revision, Applied: true})
	}
	return nil
}

func cloneStringMap(values map[string]string) map[string]string {
	cloned := make(map[string]string, len(values))
	for key, value := range values {
		cloned[key] = value
	}
	return cloned
}

func (s *Server) measurementConfigurationFailed(revision int64, err error) error {
	if callback := s.opts.OnMeasurementConfigurationResult; callback != nil {
		callback(MeasurementConfigurationResult{Revision: revision, Applied: false,
			Reason: "ocpp_configuration_incompatible"})
	}
	return err
}
