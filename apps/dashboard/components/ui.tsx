export function Panel({ title, action, children }: { title?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-base-border bg-base-surface">
      {title && (
        <div className="flex items-center justify-between px-4 py-3 border-b border-base-border">
          <h2 className="text-sm font-medium text-text-primary">{title}</h2>
          {action}
        </div>
      )}
      <div className="p-4">{children}</div>
    </div>
  );
}

export function StatCard({ label, value, sublabel, tone }: { label: string; value: string | number; sublabel?: string; tone?: "nominal" | "suspicious" | "high" | "critical" }) {
  const toneColor = tone ? `text-signal-${tone}` : "text-text-primary";
  return (
    <div className="rounded-lg border border-base-border bg-base-surface px-4 py-3.5">
      <div className="text-[11px] uppercase tracking-wide text-text-muted">{label}</div>
      <div className={`mt-1 font-mono text-2xl font-semibold ${toneColor}`}>{value}</div>
      {sublabel && <div className="mt-0.5 text-xs text-text-muted">{sublabel}</div>}
    </div>
  );
}

const BAND_STYLES: Record<string, string> = {
  ALLOW: "bg-signal-nominal/15 text-signal-nominal border-signal-nominal/30",
  ALLOW_MONITOR: "bg-signal-suspicious/15 text-signal-suspicious border-signal-suspicious/30",
  THROTTLE: "bg-signal-high/15 text-signal-high border-signal-high/30",
  BLOCK: "bg-signal-critical/15 text-signal-critical border-signal-critical/30",
};

export function DecisionBadge({ decision }: { decision: string }) {
  const style = BAND_STYLES[decision] ?? "bg-base-raised text-text-secondary border-base-border";
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-mono ${style}`}>
      {decision}
    </span>
  );
}

export function StatusCodeBadge({ status }: { status: number }) {
  let color = "text-signal-nominal";
  if (status >= 500) color = "text-signal-critical";
  else if (status >= 400) color = "text-signal-high";
  else if (status >= 300) color = "text-signal-suspicious";
  return <span className={`font-mono text-xs ${color}`}>{status}</span>;
}

export function EmptyState({ message }: { message: string }) {
  return <div className="py-10 text-center text-sm text-text-muted">{message}</div>;
}

export function Button({
  children,
  onClick,
  variant = "primary",
  disabled,
  type = "button",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  const styles = {
    primary: "bg-accent text-base-bg hover:bg-accent/90",
    secondary: "bg-base-raised text-text-primary border border-base-border hover:border-text-muted",
    danger: "bg-signal-critical/15 text-signal-critical border border-signal-critical/30 hover:bg-signal-critical/25",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${styles[variant]}`}
    >
      {children}
    </button>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`rounded border border-base-border bg-base-bg px-3 py-1.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent ${props.className ?? ""}`}
    />
  );
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`rounded border border-base-border bg-base-bg px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:border-accent ${props.className ?? ""}`}
    />
  );
}
