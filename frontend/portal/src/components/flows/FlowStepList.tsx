/**
 * Portal v3 M5 · Part E - the PHONE view of an automation: a vertical step
 * list, not a mini canvas. Every sentence + live value comes from the pure
 * `flows/stepList.ts`; this component only renders, plus the pause action
 * (the existing per-flow deactivate).
 */
import { Button } from '../../../designsystem/components/core/Button';
import { Icon } from '../../../designsystem/components/core/Icon';
import type { FlowStep } from '../../flows/stepList';

const KIND_ICON: Record<FlowStep['kind'], 'activity' | 'help-circle' | 'zap'> = {
  daten: 'activity',
  bedingung: 'help-circle',
  aktion: 'zap',
};

interface FlowStepListProps {
  steps: FlowStep[];
  /** The deployed-version line ("Läuft auf dem Gerät · v4"). */
  statusLabel: string;
  statusTone: 'ok' | 'warn' | 'off';
  /** Present only while the automation is running. */
  onPause?: () => void;
  pauseBusy?: boolean;
}

export function FlowStepList({
  steps,
  statusLabel,
  statusTone,
  onPause,
  pauseBusy,
}: FlowStepListProps) {
  return (
    <div className="vp-stepflow" data-testid="flow-steplist">
      <p className={`vp-stepflow-status ${statusTone}`}>{statusLabel}</p>
      {steps.length === 0 && (
        <p className="vp-flowed-help">Diese Automation hat noch keine Bausteine.</p>
      )}
      <ol className="vp-stepflow-list">
        {steps.map((step, i) => (
          <li key={step.nodeId} className={`vp-stepflow-item ${step.kind}`}>
            <span className="vp-stepflow-num" aria-hidden="true">{i + 1}</span>
            <span className="vp-stepflow-body">
              <span className="vp-stepflow-text">
                <Icon name={KIND_ICON[step.kind]} size={14} /> {step.text}
              </span>
              {(step.value || step.state) && (
                <span className="vp-stepflow-meta">
                  {step.value && <b className="vp-stepflow-value">{step.value}</b>}
                  {step.state && (
                    <span className={`vp-stepflow-state ${step.tone ?? 'off'}`}>{step.state}</span>
                  )}
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
      {onPause && (
        <Button variant="outline" size="sm" onClick={onPause} disabled={pauseBusy}>
          Automation anhalten
        </Button>
      )}
      <p className="vp-flowed-help">
        Zum Bearbeiten öffnen Sie diese Automation an einem größeren Bildschirm.
      </p>
    </div>
  );
}
