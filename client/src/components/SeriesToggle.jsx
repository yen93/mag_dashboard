// Clickable legend chips that show/hide individual chart series.
export default function SeriesToggle({ series, visible, onToggle }) {
  return (
    <div className="chips">
      {series.map((s) => {
        const on = visible[s.key];
        return (
          <button
            key={s.key}
            type="button"
            className={`chip ${on ? 'on' : 'off'}`}
            aria-pressed={on}
            onClick={() => onToggle(s.key)}
          >
            <span className="swatch" style={{ background: s.color }} />
            {s.label}
          </button>
        );
      })}
    </div>
  );
}
