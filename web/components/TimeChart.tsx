"use client";
import { useEffect, useRef, useState } from "react";
import type { IChartApi, ISeriesApi, SeriesType, UTCTimestamp } from "lightweight-charts";
import { num, pct, usd } from "@/lib/format";

export type ChartSeries = {
  name: string;
  kind: "line" | "area" | "histogram";
  color: string;
  data: { t: number; v: number; color?: string }[]; // t in ms
};

const fmt = (f: "usd" | "pct" | "num", v: number) => (f === "usd" ? usd(v, { compact: true }) : f === "pct" ? pct(v, 2, true) : num(v, Math.abs(v) < 10 ? 4 : 2, true)); // unit prices hover near 1.0; 2 dp would read "1.00" for every point

function describe(s: ChartSeries, format: "usd" | "pct" | "num") {
  if (!s.data.length) return `${s.name} no data`;
  const by = [...s.data].sort((a, b) => a.t - b.t);
  return `${s.name} ${fmt(format, by[0].v)} to ${fmt(format, by[by.length - 1].v)}`.trim();
}

type Readout = { t?: number; vals: (number | undefined)[] };

function build(lc: typeof import("lightweight-charts"), host: HTMLDivElement, series: ChartSeries[], height: number, format: "usd" | "pct" | "num", setReadout: (r: Readout) => void) {
  const { AreaSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries, createChart } = lc;
  const css = getComputedStyle(document.documentElement);
  const v = (n: string) => css.getPropertyValue(n).trim();
  const chart: IChartApi = createChart(host, {
    autoSize: true,
    height,
    layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: v("--ink-3"), fontFamily: "var(--font-plex), system-ui", fontSize: 11, attributionLogo: false },
    grid: { vertLines: { visible: false }, horzLines: { color: v("--grid") } },
    rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false, timeVisible: series.some((s) => s.data.length > 1 && s.data[1].t - s.data[0].t < 86_400_000) },
    crosshair: { mode: CrosshairMode.Magnet, vertLine: { color: v("--line-strong"), labelBackgroundColor: v("--surface-2") }, horzLine: { color: v("--line-strong"), labelBackgroundColor: v("--surface-2") } },
    localization: { priceFormatter: (p: number) => fmt(format, p) },
    handleScroll: false,
    handleScale: false,
  });
  const apis: ISeriesApi<SeriesType>[] = series.map((s) => {
    const common = { priceLineVisible: false, lastValueVisible: false };
    const api =
      s.kind === "histogram"
        ? chart.addSeries(HistogramSeries, { ...common, color: s.color })
        : s.kind === "area"
          ? chart.addSeries(AreaSeries, { ...common, lineColor: s.color, topColor: s.color + "40", bottomColor: s.color + "00", lineWidth: 2 })
          : chart.addSeries(LineSeries, { ...common, color: s.color, lineWidth: 2 });
    const seen = new Set<number>();
    const data = s.data
      .map((d) => ({ time: Math.floor(d.t / 1000) as UTCTimestamp, value: d.v, ...(d.color ? { color: d.color } : {}) }))
      .sort((a, b) => a.time - b.time)
      .filter((d) => (seen.has(d.time) ? false : (seen.add(d.time), true)));
    api.setData(data);
    return api;
  });
  chart.timeScale().fitContent();
  const last = () => setReadout({ vals: series.map((s) => s.data[s.data.length - 1]?.v) });
  last();
  chart.subscribeCrosshairMove((p) => {
    if (!p.time) return last();
    setReadout({
      t: (p.time as number) * 1000,
      vals: apis.map((a) => {
        const d = p.seriesData.get(a) as { value?: number } | undefined;
        return d?.value;
      }),
    });
  });
  return chart;
}

/**
 * Thin wrapper on lightweight-charts: one value axis, recessive grid,
 * crosshair readout doubling as the legend. Never dual-axis.
 */
export function TimeChart({ series, height = 240, format = "usd", ariaLabel }: { series: ChartSeries[]; height?: number; format?: "usd" | "pct" | "num"; ariaLabel: string }) {
  const el = useRef<HTMLDivElement>(null);
  const [readout, setReadout] = useState<Readout>({ vals: [] });

  useEffect(() => {
    const host = el.current;
    if (!host) return;
    // ponytail: build the chart only once it scrolls near view, and load lightweight-charts then (pages stack many charts)
    let chart: IChartApi | undefined;
    let dead = false;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return;
        io.disconnect();
        import("lightweight-charts").then((lc) => {
          if (!dead) chart = build(lc, host, series, height, format, setReadout);
        });
      },
      { rootMargin: "300px" },
    );
    io.observe(host);
    return () => {
      dead = true;
      io.disconnect();
      chart?.remove();
    };
  }, [series, height, format]);

  return (
    <figure aria-label={ariaLabel} className="relative">
      <figcaption className="mb-2 flex min-h-5 flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-3">
        {series.map((s, i) => (
          <span key={s.name} className="inline-flex items-center gap-1.5">
            {series.length > 1 && <span aria-hidden className="inline-block h-2 w-2 rounded-sm" style={{ background: s.color }} />}
            {s.name}
            <span className="num text-ink">{readout.vals[i] != null ? fmt(format, readout.vals[i]!) : ""}</span>
          </span>
        ))}
        {readout.t && <span className="num ml-auto">{new Date(readout.t).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</span>}
      </figcaption>
      {/* the canvas is invisible to screen readers: say what it shows, first to last point */}
      <div ref={el} style={{ height }} role="img" aria-label={`${ariaLabel}: ${series.map((s) => describe(s, format)).join("; ")}`} />
    </figure>
  );
}
