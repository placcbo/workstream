const LAYERS = [
  { key: "reserved", label: "Reserved Blocks", colorVar: "--lime" },
  { key: "open", label: "New Opportunities", colorVar: "--amber" },
  { key: "completed", label: "Events", colorVar: "--sky" },
];

export default function CalendarLayers({ visibleLayers, onToggle }) {
  return (
    <div className="calendar-layers">
      <div className="calendar-layers-title">My calendar</div>
      {LAYERS.map((layer) => (
        <label key={layer.key} className="calendar-layer-row">
          <input
            type="checkbox"
            checked={visibleLayers.has(layer.key)}
            onChange={() => onToggle(layer.key)}
          />
          <span className="calendar-layer-swatch" style={{ background: `var(${layer.colorVar})` }} />
          <span>{layer.label}</span>
        </label>
      ))}
    </div>
  );
}
