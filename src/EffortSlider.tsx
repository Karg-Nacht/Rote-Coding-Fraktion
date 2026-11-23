import { useEffect, useState, type CSSProperties } from "react";
import "./effort-slider.css";

// Draw each ribbon continuously across all three periods, without tile edges.
// Periodic positions AND tangents match when the layer moves by one period.
const period = 320;
const width = period * 3;
const colors = ["#33c3cf", "#f7fafb", "#ad348f"];
function ribbonEdge(x: number, offset: number, phase: number, side: number) {
  const t = ((x % period) / period) * Math.PI * 2;
  const frequency = (Math.PI * 2) / period;
  return {
    y:
      offset +
      25 * Math.sin(t) +
      7 * Math.sin(2 * t + 0.6) +
      side * (9 + 3 * Math.sin(t + phase)),
    slope:
      frequency *
      (25 * Math.cos(t) +
        14 * Math.cos(2 * t + 0.6) +
        side * 3 * Math.cos(t + phase)),
  };
}
function ribbonPath(offset: number, phase: number) {
  const step = period / 20;
  const n = (value: number) => value.toFixed(3);
  let path = `M0,${n(ribbonEdge(0, offset, phase, -1).y)}`;
  for (const side of [-1, 1]) {
    const direction = side === -1 ? 1 : -1;
    if (side === 1)
      path += `L${width},${n(ribbonEdge(width, offset, phase, side).y)}`;
    for (let i = 0; i < 60; i++) {
      const from = direction === 1 ? i * step : width - i * step;
      const to = from + direction * step;
      const a = ribbonEdge(from, offset, phase, side);
      const b = ribbonEdge(to, offset, phase, side);
      const tangent = (to - from) / 3;
      path += `C${n(from + tangent)},${n(a.y + a.slope * tangent)} ${n(to - tangent)},${n(b.y - b.slope * tangent)} ${to},${n(b.y)}`;
    }
  }
  return `${path}Z`;
}
const ribbons = Array.from({ length: 8 }, (_, index) => ({
  color: colors[index % colors.length],
  path: ribbonPath(-64 + index * 29, index * 1.4),
}));

export function EffortSlider({
  value,
  max,
  label,
  valueText,
  defaultState,
  change,
}: {
  value: number;
  max: number;
  label: string;
  valueText: string;
  defaultState: boolean;
  change: (value: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const ratio = Math.max(0, Math.min(1, value / max));
  useEffect(() => {
    if (!dragging) return;
    const end = () => setDragging(false);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", end);
    };
  }, [dragging]);
  return (
    <div
      className={`effort-track effort-psychedelic ${defaultState ? "effort-default" : ""} ${dragging ? "is-dragging" : ""}`}
      style={
        {
          "--effort-progress": `${ratio * 100}%`,
          "--effort-orb-left": `calc(${ratio * 100}% + ${11.5 - 23 * ratio}px)`,
          "--effort-period": `${18 - 10 * ratio}s`,
          "--effort-chroma": 0.95 + 0.15 * ratio,
          "--effort-light": 0.9 + 0.1 * ratio,
          "--effort-glow": 0.12 + 0.18 * ratio,
        } as CSSProperties
      }
    >
      <div className="effort-spectrum" aria-hidden="true">
        <svg
          className="effort-spectrum-motion"
          viewBox={`0 0 ${width} 80`}
          preserveAspectRatio="none"
          focusable="false"
        >
          <g>
            <rect width={width} height="80" fill="#080a0e" />
            {ribbons.map((ribbon, index) => (
              <path key={index} d={ribbon.path} fill={ribbon.color} />
            ))}
          </g>
        </svg>
        <span className="effort-spectrum-shade" />
      </div>
      <div className="effort-dots" aria-hidden="true">
        {Array.from({ length: max + 1 }, (_, i) => (
          <i className={i <= value ? "passed" : ""} key={i} />
        ))}
      </div>
      <span className="effort-orb" aria-hidden="true" />
      <input
        type="range"
        data-autofocus
        min={0}
        max={max}
        step={1}
        value={value}
        aria-label={label}
        aria-valuetext={valueText}
        onChange={(event) => change(Number(event.target.value))}
        onPointerDown={() => setDragging(true)}
        onBlur={() => setDragging(false)}
      />
    </div>
  );
}
