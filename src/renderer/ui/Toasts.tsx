import { X, CheckCircle2, AlertTriangle, AlertCircle, Info } from 'lucide-react';
import { useToasts, dismissToast } from '../state/toast';

const ICON = {
  ok: <CheckCircle2 size={15} className="ok-text" />,
  warn: <AlertTriangle size={15} className="warn-text" />,
  error: <AlertCircle size={15} className="err-text" />,
  info: <Info size={15} className="info-text" />,
};

export function Toasts() {
  const list = useToasts((x) => x.list);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={'toast ' + t.kind}>
          {ICON[t.kind]}
          <span className="grow">{t.msg}</span>
          {t.action && <button className="btn small" onClick={() => { t.action!.run(); dismissToast(t.id); }}>{t.action.label}</button>}
          <button className="icon-btn small" onClick={() => dismissToast(t.id)} aria-label="Dismiss"><X size={13} /></button>
        </div>
      ))}
    </div>
  );
}
